package core

import (
	"testing"

	"github.com/patriceckhart/zot/packages/provider"
)

func TestAppendUserContextAddsAndPublishesMessage(t *testing.T) {
	agent := NewAgent(nil, "", "", nil)
	var appended []provider.Message
	agent.OnMessageAppended = func(msg provider.Message) {
		appended = append(appended, msg)
	}

	before := agent.Revision()
	agent.AppendUserContext("$ pwd\n\n/tmp\n\n[exit 0]", map[string]string{"shell_escape": "true"})

	messages := agent.Messages()
	if len(messages) != 1 {
		t.Fatalf("Messages() length = %d, want 1", len(messages))
	}
	msg := messages[0]
	if msg.Role != provider.RoleUser {
		t.Fatalf("message role = %q, want %q", msg.Role, provider.RoleUser)
	}
	if msg.Meta["shell_escape"] != "true" {
		t.Fatalf("message metadata = %v, want shell_escape marker", msg.Meta)
	}
	if len(msg.Content) != 1 {
		t.Fatalf("message content length = %d, want 1", len(msg.Content))
	}
	text, ok := msg.Content[0].(provider.TextBlock)
	if !ok || text.Text != "$ pwd\n\n/tmp\n\n[exit 0]" {
		t.Fatalf("message content = %#v", msg.Content[0])
	}
	if msg.Time.IsZero() {
		t.Fatal("message timestamp is zero")
	}
	if agent.Revision() != before+1 {
		t.Fatalf("Revision() = %d, want %d", agent.Revision(), before+1)
	}
	if len(appended) != 1 || appended[0].Meta["shell_escape"] != "true" {
		t.Fatalf("OnMessageAppended messages = %#v", appended)
	}
}
