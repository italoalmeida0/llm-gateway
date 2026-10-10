package main

// Regression tests for queue/steering fixes:
//  1. A queued message promoted for mid-turn steering carries the same date
//     system-directives as a normal opening prompt (and advances LastDate).
//  2. queue_op add/update validate attachment ids like the direct prompt path.
//  3. queue_op update with an explicit attachment list is a full-item update:
//     empty text clears the item.

import (
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func queueTestActor(t *testing.T) *sessionActor {
	t.Helper()
	rec := &SessionRecord{ID: "sess-q", Options: normalizedOptions(SessionOptions{})}
	st := newDiskStore(t.TempDir())
	if err := st.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	a := newSessionActor(rec.ID, rec, st, nil, nil, nil)
	return a
}

func queueOp(t *testing.T, a *sessionActor, m queueOpMsg) queueOpResult {
	t.Helper()
	reply := make(chan any, 1)
	m.Reply = reply
	a.handleData(Envelope{Payload: m})
	return (<-reply).(queueOpResult)
}

// BUG-QUEUE-01 regression: the steering message must announce a date change
// exactly like seededUserMessage does for a normal opening prompt.
func TestQueuedSteeringCarriesDateDirective(t *testing.T) {
	rec := &SessionRecord{
		ID:       "sess-q-date",
		LastDate: "2026-10-09", // yesterday: a date change is due
		Options:  normalizedOptions(SessionOptions{}),
		TurnSeq:  3,
	}
	st := newDiskStore(t.TempDir())
	if err := st.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	a := newSessionActor(rec.ID, rec, st, nil, nil, nil)
	msg := a.buildQueuedUserMessage(QueuedMessage{ID: "q1", Text: "continue"})
	var text string
	for _, c := range msg.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			text += tb.Text
		}
	}
	if !strings.Contains(text, "Current date") {
		t.Fatalf("steering message lacks the date directive: %q", text)
	}
	if rec.LastDate == "2026-10-09" {
		t.Fatal("LastDate must advance after the directive is emitted")
	}
	// Second promotion on the same date must NOT repeat the directive.
	msg2 := a.buildQueuedUserMessage(QueuedMessage{ID: "q2", Text: "again"})
	var text2 string
	for _, c := range msg2.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			text2 += tb.Text
		}
	}
	if strings.Contains(text2, "Current date") {
		t.Fatalf("date directive repeated without a date change: %q", text2)
	}
}

// BUG-QUEUE-02 regression: queue add/update reject unknown attachment ids.
func TestQueueOpsValidateAttachments(t *testing.T) {
	a := queueTestActor(t)
	res := queueOp(t, a, queueOpMsg{Op: "add", Text: "later", AttachmentIDs: []string{"nope"}})
	if res.Error == "" {
		t.Fatalf("queue add accepted unvalidated attachment ids: %+v", res.Items)
	}
	res = queueOp(t, a, queueOpMsg{Op: "add", Text: "later"})
	if res.Error != "" {
		t.Fatal(res.Error)
	}
	id := res.Items[0].ID
	res = queueOp(t, a, queueOpMsg{Op: "update", ID: id, AttachmentIDs: []string{"bogus"}})
	if res.Error == "" {
		t.Fatalf("queue update accepted unvalidated attachment ids: %+v", res.Items)
	}
}

// BUG-QUEUE-03 regression: a full-item update (attachments present) with empty
// text clears the item; a partial update (no attachments) leaves text alone.
func TestQueueUpdateCanClearText(t *testing.T) {
	a := queueTestActor(t)
	res := queueOp(t, a, queueOpMsg{Op: "add", Text: "original"})
	if res.Error != "" {
		t.Fatal(res.Error)
	}
	id := res.Items[0].ID
	// Partial update: empty text, no attachments -> no change.
	res = queueOp(t, a, queueOpMsg{Op: "update", ID: id, Text: ""})
	if res.Error != "" {
		t.Fatal(res.Error)
	}
	if res.Items[0].Text != "original" {
		t.Fatalf("partial update must not clear text, got %q", res.Items[0].Text)
	}
	// Full update: empty text + explicit attachment list -> text cleared.
	res = queueOp(t, a, queueOpMsg{Op: "update", ID: id, Text: "", AttachmentIDs: []string{}})
	if res.Error != "" {
		t.Fatal(res.Error)
	}
	if res.Items[0].Text != "" {
		t.Fatalf("full update must allow clearing text, got %q", res.Items[0].Text)
	}
}
