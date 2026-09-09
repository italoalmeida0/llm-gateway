package core

import (
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func testMsg(role provider.Role, text string) provider.Message {
	return textMsg(role, text)
}

func testToolTurn(id string) (provider.Message, provider.Message) {
	call, res := toolTurn("read", `{"path":"x"}`, "file contents here")
	// Re-ID the pair so tests can distinguish turns.
	setCallID := func(m provider.Message) provider.Message {
		out := m
		out.Content = append([]provider.Content(nil), m.Content...)
		switch c := out.Content[0].(type) {
		case provider.ToolCallBlock:
			c.ID = id
			out.Content[0] = c
		case provider.ToolResultBlock:
			c.CallID = id
			out.Content[0] = c
		}
		return out
	}
	return setCallID(call), setCallID(res)
}

func TestBuildContextKeepsTranscriptUntouched(t *testing.T) {
	a := NewAgent(nil, "m", "", nil)
	call, res := testToolTurn("c1")
	a.messages = []provider.Message{
		testMsg(provider.RoleUser, "hello"),
		call, res,
		testMsg(provider.RoleAssistant, "done"),
	}
	before := len(a.messages)

	a.AddTransform(func(msgs []provider.Message) []provider.Message {
		out := append([]provider.Message(nil), msgs...)
		out = append(out, testMsg(provider.RoleUser, "injected AGENTS.md"))
		return out
	})

	ctx := a.BuildContext()
	if len(a.messages) != before {
		t.Fatalf("BuildContext mutated transcript: %d -> %d", before, len(a.messages))
	}
	if len(ctx) != before+1 {
		t.Fatalf("expected injected message in context, got %d msgs (transcript %d)", len(ctx), before)
	}
	if extractText(ctx[len(ctx)-1]) != "injected AGENTS.md" {
		t.Fatalf("injected message not last: %q", extractText(ctx[len(ctx)-1]))
	}
}

func TestBuildContextFiltersHidden(t *testing.T) {
	a := NewAgent(nil, "m", "", nil)
	hidden := testMsg(provider.RoleUser, "internal status")
	hidden.Meta = map[string]string{MetaHidden: "true"}
	a.messages = []provider.Message{
		testMsg(provider.RoleUser, "visible"),
		hidden,
	}
	ctx := a.BuildContext()
	if len(ctx) != 1 || extractText(ctx[0]) != "visible" {
		t.Fatalf("hidden message leaked into context: %+v", ctx)
	}
}

func TestRemindersAreRequestOnly(t *testing.T) {
	a := NewAgent(nil, "m", "", nil)
	a.messages = []provider.Message{testMsg(provider.RoleUser, "hi")}
	a.RemindersForTurn = func() []Reminder {
		return []Reminder{{Text: "[system reminder] queued follow-up", Meta: map[string]string{"reminder": "queued"}}}
	}
	ctx := a.BuildContext()
	if len(ctx) != 2 {
		t.Fatalf("expected reminder appended, got %d", len(ctx))
	}
	last := ctx[1]
	if last.Meta[MetaEphemeral] != "true" {
		t.Fatalf("reminder must be ephemeral: %+v", last.Meta)
	}
	if len(a.messages) != 1 {
		t.Fatalf("reminder leaked into transcript")
	}
}

func TestQueuedReminderFires(t *testing.T) {
	a := NewAgent(nil, "m", "", nil)
	a.messages = []provider.Message{testMsg(provider.RoleUser, "hi")}
	if rs := queuedReminder(a); len(rs) != 0 {
		t.Fatalf("no queued messages: expected no reminder, got %v", rs)
	}
	a.QueueMessage("follow-up")
	rs := queuedReminder(a)
	if len(rs) != 1 || !strings.Contains(rs[0].Text, "follow-up message") {
		t.Fatalf("expected queued reminder, got %+v", rs)
	}
	// Queue untouched: delivery still happens via appendQueuedAsUser.
	if a.QueuedMessageCount() != 1 {
		t.Fatalf("reminder must not consume the queue")
	}
}

func TestAssistantTextTransforms(t *testing.T) {
	msg := testMsg(provider.RoleAssistant, "secret abc-123")
	// Suppress.
	out, suppressed := applyAssistantTextTransforms(msg, []AssistantTextTransform{
		func(text string) (string, bool) { return "", false },
	})
	if !suppressed {
		t.Fatalf("expected suppression")
	}
	_ = out
	// Replace.
	out, suppressed = applyAssistantTextTransforms(msg, []AssistantTextTransform{
		func(text string) (string, bool) { return "redacted", true },
	})
	if suppressed {
		t.Fatalf("unexpected suppression")
	}
	if extractText(out) != "redacted" {
		t.Fatalf("expected replacement, got %q", extractText(out))
	}
	if extractText(msg) != "secret abc-123" {
		t.Fatalf("transform mutated input")
	}
}

func TestSnapCutToUserBoundary(t *testing.T) {
	call, res := testToolTurn("c9")
	msgs := []provider.Message{
		testMsg(provider.RoleUser, "old"),
		call, res,
		testMsg(provider.RoleUser, "new"),
		testMsg(provider.RoleAssistant, "answering new"),
	}
	// Pair-safe index 1 starts mid-turn (assistant call); must snap to 3.
	if got := snapCutToUserBoundary(msgs, 1); got != 3 {
		t.Fatalf("expected snap to user boundary 3, got %d", got)
	}
	// Already at a user boundary: unchanged.
	if got := snapCutToUserBoundary(msgs, 3); got != 3 {
		t.Fatalf("expected 3, got %d", got)
	}
}

func TestSQLiteStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/s.db"
	st, err := OpenSQLiteSessionStore(path, dir, SessionMeta{Provider: "p", Model: "m", Version: "v"})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.AppendMessage(testMsg(provider.RoleUser, "hello")); err != nil {
		t.Fatal(err)
	}
	call, res := testToolTurn("c7")
	if err := st.AppendMessage(call); err != nil {
		t.Fatal(err)
	}
	if err := st.AppendMessage(res); err != nil {
		t.Fatal(err)
	}
	if err := st.AppendUsage(provider.Usage{InputTokens: 5}, provider.Usage{InputTokens: 5}); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st2, err := OpenSQLiteSessionStore(path, dir, SessionMeta{})
	if err != nil {
		t.Fatal(err)
	}
	defer st2.Close()
	msgs, err := st2.ReadTranscript()
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(msgs))
	}
	cum, _, err := st2.Usage()
	if err != nil {
		t.Fatal(err)
	}
	if cum.InputTokens != 5 {
		t.Fatalf("expected cumulative 5 input tokens, got %+v", cum)
	}
}

func TestSQLiteCompactionCheckpoint(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/s.db"
	st, err := OpenSQLiteSessionStore(path, dir, SessionMeta{Provider: "p", Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	for i := 0; i < 5; i++ {
		if err := st.AppendMessage(testMsg(provider.RoleUser, "old")); err != nil {
			t.Fatal(err)
		}
	}
	// Append-only checkpoint: history untouched, chain head advances;
	// projection derives the compacted view.
	state := &CompactionState{
		PreviousSummary: "s",
		ModifiedFiles:   []string{"a.go"},
		KeepFrom:        3,
		Count:           1,
	}
	if err := st.AppendCompaction(state); err != nil {
		t.Fatal(err)
	}
	msgs, err := st.ReadTranscript()
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 5 {
		t.Fatalf("compaction must be append-only; full history = 5 rows, got %d", len(msgs))
	}
	projected := projectMessages(msgs, st.CompactionState())
	if len(projected) != 3 || extractText(projected[1]) != "old" {
		t.Fatalf("projection must be [summary][3 kept rows], got %+v", projected)
	}
	if tb, ok := projected[0].Content[0].(provider.TextBlock); !ok || tb.Text != summaryMessageText("s") {
		t.Fatalf("projected summary head wrong: %+v", projected[0])
	}
	if st.CompactionState() == nil || st.CompactionState().Count != 1 {
		t.Fatalf("chain head not kept: %+v", st.CompactionState())
	}
}

func TestAgentPersistsThroughStore(t *testing.T) {
	dir := t.TempDir()
	st, err := OpenSQLiteSessionStore(dir+"/s.db", dir, SessionMeta{Provider: "p", Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	a := NewAgent(nil, "m", "", nil)
	a.AttachStore(st)
	a.AppendUserContextForTest(testMsg(provider.RoleAssistant, "hi"))
	msgs, err := st.ReadTranscript()
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 {
		t.Fatalf("expected 1 persisted message, got %d", len(msgs))
	}
}

// AppendUserContextForTest appends msg to the transcript through the
// same path as the live loop (fireMessageAppended -> store + hook).
func (a *Agent) AppendUserContextForTest(msg provider.Message) {
	a.mu.Lock()
	a.messages = append(a.messages, msg)
	a.rev++
	a.mu.Unlock()
	a.fireMessageAppended(msg)
}
