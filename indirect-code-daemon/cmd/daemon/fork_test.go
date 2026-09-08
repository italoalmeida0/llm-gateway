package main

import (
	"encoding/json"
	"fmt"
	"llm-gateway/indirect-code-daemon/packages/provider"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestForkCopiesPrefixOptionsAttachmentsAndLeavesSourceUntouched(t *testing.T) {
	for _, index := range []int{0, 1, 3} {
		t.Run(fmt.Sprint(index), func(t *testing.T) {
			d := testDaemon(t)
			attachment := filepath.Join(d.sessionsDir(), "source", "attachments", "note.txt")
			if err := os.MkdirAll(filepath.Dir(attachment), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(attachment, []byte("attached content"), 0600); err != nil {
				t.Fatal(err)
			}
			rec := &SessionRecord{ID: "source", CWD: t.TempDir(), Title: "Original", Model: "custom", Status: "running", Options: SessionOptions{Mode: "plan", Effort: "high", Access: "ask", Skills: []string{"review"}}, Usage: provider.Usage{OutputTokens: 100}, Attachments: []AttachmentRef{{ID: "attachment", Name: "note.txt", Path: attachment}}, Messages: []provider.Message{
				{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "Inspect note.txt stored at " + attachment}}},
				{Role: provider.RoleAssistant, Content: []provider.Content{provider.ToolCallBlock{ID: "read", Name: "read", Arguments: json.RawMessage(`{"path":"note.txt"}`)}}},
				{Role: provider.RoleTool, Content: []provider.Content{provider.ToolResultBlock{CallID: "read", Content: []provider.Content{provider.TextBlock{Text: "contents"}}}}},
				{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "The answer"}}},
				{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "future message"}}},
			}}
			d.sessions["source"] = &ActiveSession{record: rec, gen: 1}
			if err := d.saveSession(rec); err != nil {
				t.Fatal(err)
			}
			before, _ := os.ReadFile(filepath.Join(d.sessionsDir(), "source.json"))
			command, _ := json.Marshal(map[string]any{"type": "fork_session", "sessionId": "source", "index": index})
			d.handleMessage(command)
			var fork *SessionRecord
			for _, summary := range d.listSessions() {
				if summary.ID != "source" {
					fork, _ = d.loadSession(summary.ID)
				}
			}
			expected := index + 1
			if index == 1 {
				expected = 3
			}
			if fork == nil || len(fork.Messages) != expected || fork.Status != "idle" || fork.CWD != rec.CWD || fork.Model != "custom" || fork.Options.Mode != "plan" || fork.Options.Effort != "high" || fork.Options.Access != "ask" || len(fork.Options.Skills) != 1 {
				t.Fatalf("incorrect fork: %+v", fork)
			}
			if fork.Turn != nil || fork.Usage.OutputTokens != 0 {
				t.Fatal("fork inherited task/spend state")
			}
			after, _ := os.ReadFile(filepath.Join(d.sessionsDir(), "source.json"))
			if string(before) != string(after) || rec.Status != "running" {
				t.Fatal("source mutated")
			}
			d.purgeSession("source")
			if len(fork.Attachments) != 1 {
				t.Fatal("attachment lost")
			}
			content, err := os.ReadFile(fork.Attachments[0].Path)
			if err != nil || string(content) != "attached content" {
				t.Fatal("fork depends on source")
			}
			text := fork.Messages[0].Content[0].(provider.TextBlock).Text
			if strings.Contains(text, attachment) || !strings.Contains(text, fork.Attachments[0].Path) {
				t.Fatal("old path retained")
			}
		})
	}
}
func TestForkRejectsInvalidBoundaries(t *testing.T) {
	d := testDaemon(t)
	if err := d.saveSession(&SessionRecord{ID: "s", Messages: []provider.Message{{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "hello"}}}, {Role: provider.RoleTool}}}); err != nil {
		t.Fatal(err)
	}
	for _, index := range []any{nil, -1, 1, 2} {
		raw, _ := json.Marshal(map[string]any{"type": "fork_session", "sessionId": "s", "index": index})
		d.handleMessage(raw)
	}
	if len(d.listSessions()) != 1 {
		t.Fatal("invalid boundary created fork")
	}
}

func TestForkWithEditTextResendsFromEditedBoundary(t *testing.T) {
	d := testDaemon(t)
	rec := &SessionRecord{ID: "src-edit", CWD: t.TempDir(), Title: "T", Model: "m", Status: "idle", Messages: []provider.Message{
		{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "original question"}}},
		{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "stale answer"}}},
		{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "later question"}}},
	}}
	d.sessions["src-edit"] = &ActiveSession{record: rec, gen: 1}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	// Fork at the first user message carrying edited text. truncateAndRun
	// would start a live turn — neutralize by pre-cancelling: instead assert
	// the fork content + resent flag path via a daemon with no provider.
	// (Full resend is covered by truncateAndRun tests; here we check the
	// boundary rewrite happened before the turn starts.)
	command, _ := json.Marshal(map[string]any{"type": "fork_session", "sessionId": "src-edit", "index": 0, "editText": "edited question"})
	done := make(chan struct{})
	go func() {
		// Let forkSession reach truncateAndRun then cancel the turn fast.
		// runAgentTurn with no provider fails fast; we only care the fork
		// was persisted with the edited text.
		defer close(done)
		d.handleMessage(command)
	}()
	<-done
	var fork *SessionRecord
	for _, summary := range d.listSessions() {
		if summary.ID != "src-edit" {
			fork, _ = d.loadSession(summary.ID)
		}
	}
	if fork == nil || len(fork.Messages) == 0 {
		t.Fatalf("no fork created: %+v", fork)
	}
	lastUser := ""
	for i := len(fork.Messages) - 1; i >= 0; i-- {
		if fork.Messages[i].Role == provider.RoleUser {
			if tb, ok := fork.Messages[i].Content[0].(provider.TextBlock); ok {
				lastUser = tb.Text
			}
			break
		}
	}
	if lastUser != "edited question" {
		t.Fatalf("boundary not rewritten: %q", lastUser)
	}
	// Source keeps the original text.
	src, _ := d.loadSession("src-edit")
	if src.Messages[0].Content[0].(provider.TextBlock).Text != "original question" {
		t.Fatal("source mutated")
	}

	// Wait for background turn to settle before temp dir cleanup
	for i := 0; i < 100; i++ {
		d.sessionsMu.RLock()
		running := false
		for _, s := range d.sessions {
			s.mu.Lock()
			if s.cancel != nil || (s.record != nil && s.record.Status == "running") {
				running = true
				if s.cancel != nil {
					s.cancel()
				}
			}
			s.mu.Unlock()
		}
		d.sessionsMu.RUnlock()
		if !running && i > 5 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
}
