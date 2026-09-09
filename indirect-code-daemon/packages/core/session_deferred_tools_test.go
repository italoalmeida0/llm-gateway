package core

import (
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestSessionPreservesActivatedDeferredTools(t *testing.T) {
	dir := t.TempDir()
	session, err := OpenSQLiteSessionStore(dir+"/s.db", "/workspace", SessionMeta{Provider: "moonshotai", Model: "kimi-k3", Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	message := provider.Message{
		Role:           provider.RoleTool,
		AddedToolNames: []string{"lookup_weather"},
		Content: []provider.Content{provider.ToolResultBlock{
			CallID:  "call-1",
			Content: []provider.Content{provider.TextBlock{Text: "enabled"}},
		}},
	}
	if err := session.AppendMessage(message); err != nil {
		t.Fatal(err)
	}
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenSQLiteSessionStore(dir+"/s.db", "/workspace", SessionMeta{})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	messages, err := reopened.ReadTranscript()
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 || len(messages[0].AddedToolNames) != 1 || messages[0].AddedToolNames[0] != "lookup_weather" {
		t.Fatalf("messages = %+v", messages)
	}
}
