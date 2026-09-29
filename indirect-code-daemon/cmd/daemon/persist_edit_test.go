package main

import (
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// Regression: persistEdited/truncateTail must survive the meta line's
// TurnActivity shape ("turn":{...} object, not a number). The typed
// `Turn int` probe used to fail the meta line with "corrupt line at
// offset" — making EVERY edit/resend/fork on a real session (any session
// that ever ran a turn) fail to save. Caught by the edit-fork e2e
// (scenario A: "corrupt line at offset 4726" on the meta line).
func TestPersistEditedWithTurnActivityMeta(t *testing.T) {
	st := newDiskStore(t.TempDir())
	rec := &SessionRecord{ID: "sess1", Turn: &TurnActivity{StartedAt: 1, Status: "completed"}}
	// Two turns with the real wire shapes: meta with user_text, tool
	// results, system-reminders.
	for i := 1; i <= 2; i++ {
		rec.Messages = append(rec.Messages,
			provider.Message{ID: "u" + string(rune('0'+i)), Role: provider.RoleUser,
				Content: []provider.Content{provider.TextBlock{Text: "Reply exactly: ALPHA"}},
				Meta:    map[string]string{"attachments": "[]", "user_text": "Reply exactly: ALPHA"}, TurnIndex: i},
			provider.Message{ID: "sr" + string(rune('0'+i)), Role: provider.RoleUser,
				Content: []provider.Content{provider.TextBlock{Text: "<system-reminder>You should continue what you are doing.</system-reminder>"}},
				Meta:    map[string]string{"user_text": "<system-reminder>You should continue what you are doing.</system-reminder>"}, TurnIndex: i},
			provider.Message{ID: "a" + string(rune('0'+i)), Role: provider.RoleAssistant,
				Content: []provider.Content{provider.TextBlock{Text: "EXACTLY: ALPHA"}}, TurnIndex: i},
			provider.Message{ID: "tr" + string(rune('0'+i)), Role: provider.RoleTool,
				Content:  []provider.Content{provider.ToolResultBlock{CallID: "call_" + string(rune('0'+i)), Content: []provider.Content{provider.TextBlock{Text: "./ (0 entries)\n"}}, StartedAt: 1, DurationMs: 3}},
				TurnIndex: i},
		)
	}
	if err := st.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	// The atomic resend path: cut turn 2 + insert a new row.
	rec.Messages = rec.Messages[:4]
	rec.Messages = append(rec.Messages, provider.Message{ID: "new", Role: provider.RoleUser,
		Content: []provider.Content{provider.TextBlock{Text: "Reply exactly: GAMMA"}},
		Meta:    map[string]string{"attachments": "[]", "user_text": "Reply exactly: GAMMA"}, TurnIndex: 2})
	if err := st.persistEdited("sess1", 2, rec.Messages, nil, recordMeta(rec)); err != nil {
		t.Fatalf("persistEdited failed on a real session (meta has TurnActivity): %v", err)
	}
	// And truncateTail (the clear/edit path) must survive too.
	if err := st.truncateTail("sess1", 1, recordMeta(rec)); err != nil {
		t.Fatalf("truncateTail failed on a real session: %v", err)
	}
}