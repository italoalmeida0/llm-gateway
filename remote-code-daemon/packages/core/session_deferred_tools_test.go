package core

import (
	"testing"

	"github.com/patriceckhart/zot/packages/provider"
)

func TestSessionPreservesActivatedDeferredTools(t *testing.T) {
	session, err := NewSession(t.TempDir(), "/workspace", "moonshotai", "kimi-k3", "test")
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
	path := session.Path
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, messages, err := OpenSession(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if len(messages) != 1 || len(messages[0].AddedToolNames) != 1 || messages[0].AddedToolNames[0] != "lookup_weather" {
		t.Fatalf("messages = %+v", messages)
	}
}
