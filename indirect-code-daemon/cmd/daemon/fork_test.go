package main

import (
	"encoding/json"
	"fmt"
	"llm-gateway/indirect-code-daemon/packages/core"
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
	// Fork at the first user message carrying edited text. The resent
	// turn re-appends the edited text via Prompt (setupAgent needs no
	// provider for the append; the model call retries in background
	// until cancelled below).
	command, _ := json.Marshal(map[string]any{"type": "fork_session", "sessionId": "src-edit", "index": 0, "editText": "edited question"})
	srcSeq := rec.TurnSeq
	d.handleMessage(command)
	var forkID string
	for _, summary := range d.listSessions() {
		if summary.ID != "src-edit" {
			forkID = summary.ID
		}
	}
	if forkID == "" {
		t.Fatal("no fork created")
	}
	countEdited := func() int {
		fork, _ := d.loadSession(forkID)
		if fork == nil {
			return 0
		}
		n := 0
		for _, m := range fork.Messages {
			if m.Role != provider.RoleUser {
				continue
			}
			for _, c := range m.Content {
				if tb, ok := c.(provider.TextBlock); ok && core.StripLeadingSystemPrompt(tb.Text) == "edited question" {
					n++
				}
			}
		}
		return n
	}
	// The resent turn stamps its appended message with the new turn seq.
	// Waiting for that exact stamp proves Prompt ran, so a later cancel
	// cannot hide the append (and the pre-truncation save, stamped older,
	// can never satisfy it).
	targetSeq := srcSeq + 1
	stamped := func() bool {
		fork, _ := d.loadSession(forkID)
		if fork == nil {
			return false
		}
		for _, m := range fork.Messages {
			if m.Role == provider.RoleUser && m.TurnIndex == targetSeq {
				for _, c := range m.Content {
					if tb, ok := c.(provider.TextBlock); ok && core.StripLeadingSystemPrompt(tb.Text) == "edited question" {
						return true
					}
				}
			}
		}
		return false
	}
	deadline := time.Now().Add(10 * time.Second)
	for !stamped() {
		if time.Now().After(deadline) {
			t.Fatal("resent append never happened")
		}
		time.Sleep(20 * time.Millisecond)
	}

	// Source keeps the original text.
	src, _ := d.loadSession("src-edit")
	if src.Messages[0].Content[0].(provider.TextBlock).Text != "original question" {
		t.Fatal("source mutated")
	}

	// Wait for background turn to settle before asserting the final count.
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
	if n := countEdited(); n != 1 {
		t.Fatalf("edited text duplicated by resend: %d copies", n)
	}
}

func TestRegeneratePicksLastUserMessageInMultiTurn(t *testing.T) {
	d := testDaemon(t)
	rec := &SessionRecord{
		ID: "multi-turn", CWD: t.TempDir(), Title: "Multi", Model: "m", Status: "idle",
		Messages: []provider.Message{
			{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "first question"}}},
			{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "first answer"}}},
			{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "second question"}}},
			{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "second answer"}}},
		},
	}
	d.sessions["multi-turn"] = &ActiveSession{record: rec, gen: 1}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}

	srcSeq := rec.TurnSeq
	targetSeq := srcSeq + 1

	// Regenerate pointing at the last user message (index 2)
	command, _ := json.Marshal(map[string]any{
		"type":      "regenerate",
		"sessionId": "multi-turn",
		"index":     2,
		"text":      "second question",
	})
	d.handleMessage(command)

	// Check that the re-run message appended by Prompt is "second question", NOT "first question"
	stamped := func() (bool, string) {
		s, _ := d.loadSession("multi-turn")
		if s == nil {
			return false, ""
		}
		for _, m := range s.Messages {
			if m.Role == provider.RoleUser && m.TurnIndex == targetSeq {
				for _, c := range m.Content {
					if tb, ok := c.(provider.TextBlock); ok {
						return true, tb.Text
					}
				}
			}
		}
		return false, ""
	}

	deadline := time.Now().Add(10 * time.Second)
	var reRunText string
	for {
		ok, txt := stamped()
		if ok {
			reRunText = txt
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("regenerate turn never started")
		}
		time.Sleep(20 * time.Millisecond)
	}

	if core.StripLeadingSystemPrompt(reRunText) != "second question" {
		t.Fatalf("regenerate picked wrong user message: got %q, want %q", reRunText, "second question")
	}

	// Clean up background turns
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

func TestForkAndRegenerate(t *testing.T) {
	d := testDaemon(t)
	rec := &SessionRecord{
		ID: "src-fork-regen", CWD: t.TempDir(), Title: "ForkRegen", Model: "m", Status: "idle",
		Messages: []provider.Message{
			{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "q1"}}},
			{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "a1"}}},
			{Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "q2"}}},
			{Role: provider.RoleAssistant, Content: []provider.Content{provider.TextBlock{Text: "a2"}}},
		},
	}
	d.sessions["src-fork-regen"] = &ActiveSession{record: rec, gen: 1}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}

	// Fork & regenerate passes index of q2 (2) and editText with q2's text
	command, _ := json.Marshal(map[string]any{
		"type":      "fork_session",
		"sessionId": "src-fork-regen",
		"index":     2,
		"editText":  "q2",
	})
	d.handleMessage(command)

	var forkID string
	for _, summary := range d.listSessions() {
		if summary.ID != "src-fork-regen" {
			forkID = summary.ID
		}
	}
	if forkID == "" {
		t.Fatal("no fork created")
	}

	// Prove Prompt ran on the fork with q2
	stamped := func() (bool, string) {
		fork, _ := d.loadSession(forkID)
		if fork == nil {
			return false, ""
		}
		for _, m := range fork.Messages {
			if m.Role == provider.RoleUser {
				for _, c := range m.Content {
					if tb, ok := c.(provider.TextBlock); ok && core.StripLeadingSystemPrompt(tb.Text) == "q2" {
						return true, tb.Text
					}
				}
			}
		}
		return false, ""
	}

	deadline := time.Now().Add(10 * time.Second)
	for {
		ok, _ := stamped()
		if ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("fork & regenerate turn never started")
		}
		time.Sleep(20 * time.Millisecond)
	}

	// Clean up background turns
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
