package main

import (
	"testing"

	"llm-gateway/indirect-code-daemon/packages/filetrack"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

func pageTestMessages() []provider.Message {
	// 3 turns: turn 1 (2 msgs), turn 2 (3 msgs), turn 3 (1 msg).
	var out []provider.Message
	mk := func(turn int, text string) {
		out = append(out, provider.Message{
			Role:      provider.RoleUser,
			TurnIndex: turn,
			Content:   []provider.Content{provider.TextBlock{Text: text}},
		})
	}
	mk(1, "t1a")
	mk(1, "t1b")
	mk(2, "t2a")
	mk(2, "t2b")
	mk(2, "t2c")
	mk(3, "t3a")
	return out
}

func TestSliceTailBlockWholeTurns(t *testing.T) {
	msgs := pageTestMessages()
	// Tiny budget via many small turns? Budget is 128k — small texts fit
	// in one block, so the tail block must contain ALL turns whole.
	b := sliceHistoryBlock(msgs, nil, 0)
	if len(b.Messages) != 6 || b.OldestTurn != 1 || b.NewestTurn != 3 {
		t.Fatalf("tail block wrong: %+v", b)
	}
	if b.HasOlder || b.TotalTurns != 3 {
		t.Fatalf("tail flags wrong: %+v", b)
	}
}

func TestSliceBeforeTurn(t *testing.T) {
	msgs := pageTestMessages()
	b := sliceHistoryBlock(msgs, nil, 3)
	if len(b.Messages) != 5 || b.OldestTurn != 1 || b.NewestTurn != 2 {
		t.Fatalf("beforeTurn=3 wrong: %d msgs %+v", len(b.Messages), b)
	}
	if b.HasOlder {
		t.Fatal("turns 1-2 are everything below 3, HasOlder must be false")
	}
	b2 := sliceHistoryBlock(msgs, nil, 2)
	if len(b2.Messages) != 2 || b2.OldestTurn != 1 || b2.NewestTurn != 1 {
		t.Fatalf("beforeTurn=2 wrong: %+v", b2)
	}
	if b2.HasOlder {
		t.Fatal("no turns below 1, HasOlder must be false")
	}
	b3 := sliceHistoryBlock(msgs, nil, 1)
	if len(b3.Messages) != 0 || b3.HasOlder {
		t.Fatalf("beforeTurn=1 must be empty: %+v", b3)
	}
}

func TestSliceBalloonsRideAlong(t *testing.T) {
	msgs := pageTestMessages()
	bals := []filetrack.TurnChanges{
		{TurnIndex: 1}, {TurnIndex: 2}, {TurnIndex: 3},
	}
	b := sliceHistoryBlock(msgs, bals, 3)
	if len(b.Balloons) != 2 {
		t.Fatalf("balloons = %d; want 2 (turns 1-2)", len(b.Balloons))
	}
}

func TestSliceEmpty(t *testing.T) {
	b := sliceHistoryBlock(nil, nil, 0)
	if len(b.Messages) != 0 || b.HasOlder || b.TotalTurns != 0 {
		t.Fatalf("empty wrong: %+v", b)
	}
}

func TestTurnTokenCountPositive(t *testing.T) {
	msgs := pageTestMessages()
	if n := turnTokenCount(msgs[:2]); n <= 0 {
		t.Fatalf("turn tokens = %d; want > 0", n)
	}
	if n := turnTokenCount(nil); n != 0 {
		t.Fatalf("empty turn tokens = %d; want 0", n)
	}
}

func TestSliceLastTurns(t *testing.T) {
	msgs := pageTestMessages()
	// Last 2 whole turns: turn 2 (3 msgs) + turn 3 (1 msg).
	b := sliceLastTurns(msgs, nil, 2)
	if len(b.Messages) != 4 || b.OldestTurn != 2 || b.NewestTurn != 3 {
		t.Fatalf("last-2 wrong: %d msgs %+v", len(b.Messages), b)
	}
	if !b.HasOlder || b.TotalTurns != 3 {
		t.Fatalf("last-2 flags wrong: %+v", b)
	}
	if b.FirstIndex != 2 {
		t.Fatalf("last-2 firstIndex = %d; want 2", b.FirstIndex)
	}
	// n larger than the session ships everything, no older.
	all := sliceLastTurns(msgs, nil, 9)
	if len(all.Messages) != 6 || all.HasOlder {
		t.Fatalf("oversized n wrong: %+v", all)
	}
	// Empty transcript: empty block, no cursor.
	empty := sliceLastTurns(nil, nil, 2)
	if len(empty.Messages) != 0 || empty.HasOlder || empty.TotalTurns != 0 {
		t.Fatalf("empty wrong: %+v", empty)
	}
}

func TestCompletionPayloadTailOnly(t *testing.T) {
	d := testDaemon(t)
	rec := &SessionRecord{ID: "completion", CWD: "/tmp", Model: "m", Status: "idle"}
	for i := 1; i <= 4; i++ {
		for j := 0; j < 2; j++ {
			rec.Messages = append(rec.Messages, provider.Message{
				Role:      provider.RoleUser,
				TurnIndex: i,
				Content:   []provider.Content{provider.TextBlock{Text: "hello"}},
			})
		}
	}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	p := completionPayload(rec)
	msgs, _ := p["messages"].([]provider.Message)
	h, _ := p["history"].(map[string]any)
	// Only turns 3-4 ship; the cursor still points at the full session.
	if len(msgs) != 4 || h["oldestTurn"] != 3 || h["newestTurn"] != 4 {
		t.Fatalf("completion tail wrong: %d msgs %+v", len(msgs), h)
	}
	if h["hasOlder"] != true || h["totalTurns"] != 4 || h["firstIndex"] != 4 {
		t.Fatalf("completion cursor wrong: %+v", h)
	}
	// Closing metadata rides whole, not truncated.
	if _, ok := p["usage"]; !ok {
		t.Fatal("completion payload missing usage key")
	}
	if _, ok := p["compaction"]; !ok {
		t.Fatal("completion payload missing compaction key")
	}
}

func TestTailContentEventShape(t *testing.T) {
	rec := &SessionRecord{ID: "tail", CWD: "/tmp", Model: "m", Status: "idle"}
	for i := 1; i <= 3; i++ {
		rec.Messages = append(rec.Messages, provider.Message{
			Role:      provider.RoleUser,
			TurnIndex: i,
			Content:   []provider.Content{provider.TextBlock{Text: "hello"}},
		})
	}
	ev := tailContentEvent("h", "tail", "session_content", rec, 0, nil)
	msgs, _ := ev["messages"].([]provider.Message)
	h, _ := ev["history"].(map[string]any)
	if ev["type"] != "session_content" || ev["sessionId"] != "tail" {
		t.Fatalf("event envelope wrong: %+v", ev)
	}
	if len(msgs) != 2 || h["oldestTurn"] != 2 || h["newestTurn"] != 3 {
		t.Fatalf("tail event wrong: %d msgs %+v", len(msgs), h)
	}
	if _, ok := ev["compaction"]; !ok {
		t.Fatal("tail event missing compaction key")
	}
}

func TestSessionPayloadPagedTail(t *testing.T) {	d := testDaemon(t)
	rec := &SessionRecord{ID: "paged", CWD: "/tmp", Model: "m", Status: "idle"}
	for i := 1; i <= 3; i++ {
		for j := 0; j < 2; j++ {
			rec.Messages = append(rec.Messages, provider.Message{
				Role:      provider.RoleUser,
				TurnIndex: i,
				Content:   []provider.Content{provider.TextBlock{Text: "hello"}},
			})
		}
	}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	p := sessionPayloadPaged(rec, 0)
	msgs, _ := p["messages"].([]provider.Message)
	h, _ := p["history"].(map[string]any)
	if len(msgs) != 6 || h["oldestTurn"] != 1 || h["newestTurn"] != 3 {
		t.Fatalf("paged tail wrong: %d msgs %+v", len(msgs), h)
	}
	if h["hasOlder"] != false || h["firstIndex"] != 0 {
		t.Fatalf("paged tail cursor wrong: %+v", h)
	}
	// beforeTurn pages backwards with the cursor.
	p2 := sessionPayloadPaged(rec, h["oldestTurn"].(int))
	h2, _ := p2["history"].(map[string]any)
	msgs2, _ := p2["messages"].([]provider.Message)
	if len(msgs2) != 0 || h2["hasOlder"] != false {
		t.Fatalf("exhausted page wrong: %d msgs %+v", len(msgs2), h2)
	}
}
