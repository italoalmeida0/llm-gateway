package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Fork a durable prefix. A tool-results envelope immediately following the
// selected assistant belongs to that same displayed bubble. Live partial output
// is not committed and cannot be used as a fork boundary.
func (d *DaemonServer) forkSession(raw []byte) {
	var req struct {
		SessionID string `json:"sessionId"`
		RequestID string `json:"requestId"`
		Index     *int   `json:"index"`
		// Fork-&-resend (edit popup): apply this text to the boundary user
		// message and re-run the turn on the copy.
		EditText  string `json:"editText"`
		EditModel string `json:"editModel"`
		EditYOLO  bool   `json:"editYolo"`
	}
	if json.Unmarshal(raw, &req) != nil {
		return
	}
	req.EditText = core.SanitizeUserText(req.EditText)
	fail := func(err error) {
		_ = d.sendWS(map[string]any{"type": "error", "hostId": d.config.HostID, "requestId": req.RequestID, "message": err.Error()})
	}
	act, err := d.getOrCreateActiveSession(req.SessionID)
	if err != nil {
		fail(fmt.Errorf("Conversation not found"))
		return
	}
	// Snapshot under the session lock; cloning never changes or stops the source.
	act.mu.Lock()
	source := act.record
	if req.Index == nil || *req.Index < 0 || *req.Index >= len(source.Messages) {
		act.mu.Unlock()
		fail(fmt.Errorf("Select a completed message to fork"))
		return
	}
	boundary := source.Messages[*req.Index]
	if boundary.Role != provider.RoleUser && boundary.Role != provider.RoleAssistant {
		act.mu.Unlock()
		fail(fmt.Errorf("Select a user or assistant message to fork"))
		return
	}
	end := *req.Index + 1
	if boundary.Role == provider.RoleAssistant {
		for end < len(source.Messages) && source.Messages[end].Role == provider.RoleTool {
			end++
		}
	}
	now := time.Now()
	rec := &SessionRecord{ID: fmt.Sprintf("sess_%d", now.UnixNano()), CWD: resolvePath(source.CWD), Title: source.Title + " (fork)", TitleSource: "manual", Model: source.Model, Options: normalizedOptions(source.Options), Status: "idle", CreatedAt: now.UnixMilli(), UpdatedAt: now.UnixMilli(), TurnSeq: source.TurnSeq}
	// Carry only balloons anchored inside the copied prefix. Their
	// MessageIndex still resolves because the prefix is message-identical.
	// Brain files never ride along: the brain is session memory, never
	// user-facing file changes (old sessions may persist them).
	for _, b := range stripBrainBalloonFiles(source.FileBalloons, d.brainDir(source.ID)) {
		if b.MessageIndex > 0 && b.MessageIndex <= end {
			rec.FileBalloons = append(rec.FileBalloons, b)
		}
	}
	rec.Options.Skills = append([]string{}, rec.Options.Skills...)
	attachments := append([]AttachmentRef{}, source.Attachments...)
	for _, msg := range source.Messages[:end] {
		data, marshalErr := json.Marshal(msg)
		if marshalErr != nil {
			err = marshalErr
			break
		}
		copy, hydrateErr := core.HydrateMessageObject(data)
		if hydrateErr != nil {
			err = hydrateErr
			break
		}
		rec.Messages = append(rec.Messages, copy)
	}
	act.mu.Unlock()
	if err != nil {
		fail(fmt.Errorf("Could not copy the conversation: %w", err))
		return
	}
	// Carry the compaction chain head when its anchor still resolves
	// inside the copied prefix (a fork keeps the compaction
	// entries reachable from its point in the log).
	if st := source.Compaction; st != nil && st.KeepFrom >= 0 && st.KeepFrom <= end {
		cp := *st
		rec.Compaction = &cp
	}
	// Copy only attachments referenced by this prefix. Inline images already carry
	// their bytes in the transcript; textual/binary attachment notes carry names.
	transcript, _ := json.Marshal(rec.Messages)
	dir := filepath.Join(d.sessionsDir(), rec.ID, "attachments")
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(filepath.Dir(dir))
		}
	}()
	for _, attachment := range attachments {
		if !strings.Contains(string(transcript), attachment.Name) && !strings.Contains(string(transcript), attachment.Path) {
			continue
		}
		paths := map[string]string{}
		for _, pair := range []struct {
			source string
			target *string
		}{{attachment.Path, &attachment.Path}, {attachment.TextPath, &attachment.TextPath}} {
			if pair.source == "" {
				continue
			}
			target := filepath.Join(dir, filepath.Base(pair.source))
			if err := copyForkAttachment(pair.source, target); err != nil {
				fail(fmt.Errorf("Could not copy attachment %s: %w", attachment.Name, err))
				return
			}
			paths[pair.source] = target
			*pair.target = target
		}
		for i := range rec.Messages {
			rec.Messages[i].Content = forkContentPaths(rec.Messages[i].Content, paths)
		}
		rec.Attachments = append(rec.Attachments, attachment)
	}
	// Fork-&-resend: apply the edited text to the boundary user message.
	// The fork ends at the edited message (user) or includes it, so it is
	// always the last user message of the copy.
	resent := false
	resentIdx := -1
	if strings.TrimSpace(req.EditText) != "" {
		for i := len(rec.Messages) - 1; i >= 0; i-- {
			if rec.Messages[i].Role != provider.RoleUser {
				continue
			}
			replaced := false
			for j, c := range rec.Messages[i].Content {
				if tb, ok := c.(provider.TextBlock); ok {
					rec.Messages[i].Content[j] = provider.TextBlock{Text: req.EditText, ThoughtSignature: tb.ThoughtSignature}
					replaced = true
					break
				}
			}
			if !replaced {
				rec.Messages[i].Content = []provider.Content{provider.TextBlock{Text: req.EditText}}
				replaced = true
			}
			if replaced {
				rec.Messages[i].Time = time.Now()
				resent = true
				resentIdx = i
			}
			break
		}
	}
	// Task state, review/undo journal and accumulated spend belong to the source.
	// The new conversation starts idle; its next request measures the copied context.
	if err := d.saveSession(rec); err != nil {
		fail(fmt.Errorf("Could not save the fork: %w", err))
		return
	}
	committed = true
	_ = d.sendWS(map[string]any{"type": "session_forked", "requestId": req.RequestID, "hostId": d.config.HostID, "session": sessionPayload(rec), "resent": resent})
	if resent {
		// Re-run the turn on the copy from the edited text, dropping the
		// edited boundary message itself: the turn re-sends it, so keeping
		// it would duplicate it.
		model := req.EditModel
		if model == "" {
			model = rec.Model
		}
		// Drop the edited boundary message itself: the turn re-sends
		// it, so keeping it would duplicate it.
		keep := resentIdx
		if keep < 0 {
			keep = len(rec.Messages)
		}
		d.truncateAndRun(rec.ID, keep, req.EditText, model, req.EditYOLO, nil)
	}
}

func copyForkAttachment(source, target string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(output, input)
	closeErr := output.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func forkContentPaths(content []provider.Content, paths map[string]string) []provider.Content {
	for i, block := range content {
		switch b := block.(type) {
		case provider.TextBlock:
			for before, after := range paths {
				b.Text = strings.ReplaceAll(b.Text, before, after)
			}
			content[i] = b
		case provider.ToolResultBlock:
			b.Content = forkContentPaths(b.Content, paths)
			content[i] = b
		}
	}
	return content
}
