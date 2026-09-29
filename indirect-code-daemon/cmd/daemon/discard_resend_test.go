package main

// Regression tests for the atomic discard&resend / fork&resend / clear
// primitives. Each models the USER-FACING contract:
//   - a message can NEVER be lost (durable row before the turn starts);
//   - one durable commit per action (cut + insert together);
//   - every path answers the client (no silent returns);
//   - regenerate reuses the original text; /clear never starts a turn.

import (
	"context"
	"strings"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func darMsgs(n int) []provider.Message {
	out := make([]provider.Message, 0, n)
	for i := 0; i < n; i++ {
		role := provider.RoleUser
		if i%2 == 1 {
			role = provider.RoleAssistant
		}
		out = append(out, provider.Message{
			ID: string(rune('a' + i)), Role: role,
			Content:   []provider.Content{provider.TextBlock{Text: "m" + string(rune('0'+i))}},
			TurnIndex: i/2 + 1,
		})
	}
	return out
}

func darActor(t *testing.T, rec *SessionRecord) (*sessionActor, *diskStore) {
	t.Helper()
	st := newDiskStore(t.TempDir())
	if err := st.saveSessionSync(rec); err != nil {
		t.Fatal(err)
	}
	a := newSessionActor(rec.ID, rec, st, nil, nil, nil)
	// Stub the worker: these tests assert the DURABLE contract (the row is
	// on disk before any turn runs), never the model turn itself. The stub
	// exits immediately so the actor's worker goroutine never touches the
	// test's temp dir after the assertions.
	a.startWorker = func(snap workerSnapshot, env workerEnv, ctx context.Context) {}
	// Close the WAL on cleanup: startSeededTurn opens one and the stubbed
	// worker never finishes the turn — on Windows the open handle blocks
	// TempDir cleanup (unlinkat: file in use).
	t.Cleanup(func() {
		if a.wal != nil {
			_ = a.wal.close()
			a.wal = nil
		}
	})
	return a, st
}

// The core guarantee: the new user row is durable BEFORE the turn starts.
// A turn that never starts (worker failure, crash) must NOT lose the text.
func TestDiscardAndResendAtomicNoLoss(t *testing.T) {
	rec := &SessionRecord{ID: "sess1", Messages: darMsgs(6)} // turns 1..3
	a, st := darActor(t, rec)
	// The turn-2 boundary is the row at index 2 ("m2").
	reply := make(chan any, 1)
	a.onDiscardAndResend(discardAndResendMsg{TurnID: 2, Text: "MY EDITED TEXT", Reply: reply})
	r := (<-reply).(discardResendResult)
	if r.Error != "" {
		t.Fatalf("discard_and_resend failed: %s", r.Error)
	}
	// The turn runs (seeded worker stub never answers) — but the row is
	// already durable: reload from DISK and find it.
	fused, _, err := st.loadSessionFused("sess1")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, m := range fused.Messages {
		for _, c := range m.Content {
			if tb, ok := c.(provider.TextBlock); ok && tb.Text == "MY EDITED TEXT" {
				found = true
			}
		}
	}
	if !found {
		t.Fatalf("EDITED TEXT LOST: not on disk after discard_and_resend (rows=%d)", len(fused.Messages))
	}
	// And the tail (turn 2+) is gone: only turn 1 + the new row remain.
	for _, m := range fused.Messages {
		for _, c := range m.Content {
			if tb, ok := c.(provider.TextBlock); ok && (tb.Text == "m2" || tb.Text == "m3" || tb.Text == "m4" || tb.Text == "m5") {
				t.Fatalf("stale tail row survived: %q", tb.Text)
			}
		}
	}
	if fused.Messages[len(fused.Messages)-1].TurnIndex != 2 {
		t.Fatalf("new row must reuse the boundary turn number: %+v", fused.Messages[len(fused.Messages)-1])
	}
}

// Empty text = regenerate: reuses the boundary row's original text.
func TestDiscardAndResendEmptyRegenerates(t *testing.T) {
	rec := &SessionRecord{ID: "sess1", Messages: darMsgs(4)}
	a, st := darActor(t, rec)
	reply := make(chan any, 1)
	a.onDiscardAndResend(discardAndResendMsg{TurnID: 2, Reply: reply})
	if r := (<-reply).(discardResendResult); r.Error != "" {
		t.Fatal(r.Error)
	}
	fused, _, err := st.loadSessionFused("sess1")
	if err != nil {
		t.Fatal(err)
	}
	last := fused.Messages[len(fused.Messages)-1]
	ok := false
	for _, c := range last.Content {
		if tb, ok2 := c.(provider.TextBlock); ok2 && tb.Text == "m2" {
			ok = true
		}
	}
	if !ok {
		t.Fatalf("regenerate must reuse the original text (m2): %+v", last.Content)
	}
}

// Every failure path answers (no silent returns): bad turn id -> error.
func TestDiscardAndResendAlwaysAnswers(t *testing.T) {
	rec := &SessionRecord{ID: "sess1", Messages: darMsgs(4)}
	a, _ := darActor(t, rec)
	for _, turn := range []int{0, -1, 99} {
		reply := make(chan any, 1)
		a.onDiscardAndResend(discardAndResendMsg{TurnID: turn, Text: "x", Reply: reply})
		select {
		case r := <-reply:
			if dr := r.(discardResendResult); dr.Error == "" {
				t.Fatalf("turn %d: silent success on a bad id", turn)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("turn %d: NO ANSWER at all (silent drop)", turn)
		}
	}
}

// Running turn: sendNow semantics — stash + cancel, the finalizer applies
// the op (never "turn already in flight", never lost).
func TestDiscardAndResendDuringRunningTurn(t *testing.T) {
	rec := &SessionRecord{ID: "sess1", Messages: darMsgs(4)}
	a, st := darActor(t, rec)
	// Fake a running turn with a live worker: doCancel defers to the
	// finalizer (finishTurn) instead of finishing inline.
	a.state = stateRunning
	a.workerDone = make(chan struct{})
	reply := make(chan any, 1)
	a.onDiscardAndResend(discardAndResendMsg{TurnID: 2, Text: "AFTER CANCEL", Reply: reply})
	if a.pendingResend == nil {
		t.Fatal("op must be stashed until the running turn gives way")
	}
	// The finalizer (finishTurn) applies it.
	a.finishTurn(false)
	select {
	case r := <-reply:
		if dr := r.(discardResendResult); dr.Error != "" {
			t.Fatalf("stashed op failed: %s", dr.Error)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stashed op never answered")
	}
	fused, _, err := st.loadSessionFused("sess1")
	if err != nil {
		t.Fatal(err)
	}
	last := fused.Messages[len(fused.Messages)-1]
	ok := false
	for _, c := range last.Content {
		if tb, ok2 := c.(provider.TextBlock); ok2 && tb.Text == "AFTER CANCEL" {
			ok = true
		}
	}
	if !ok {
		t.Fatalf("stashed op lost the text: %+v", last.Content)
	}
}

// fork_and_resend: the fork holds the prefix ABOVE the turn + the new row
// (durable there before its turn starts). fork normal INCLUDES the turn.
func TestForkAndResendVsPlainFork(t *testing.T) {
	rec := &SessionRecord{ID: "sess1", Messages: darMsgs(6)} // turns 1..3
	a, st := darActor(t, rec)
	// Plain fork at turn 2 (keep = row index 3 = the LAST row of the
	// boundary turn: m2=user, m3=assistant -> end=4 includes it all).
	fch := make(chan any, 1)
	a.onFork(forkReqMsg{Keep: 3, Title: "t", Reply: fch})
	fr := (<-fch).(forkResult)
	if fr.Error != "" {
		t.Fatal(fr.Error)
	}
	plain, _, err := st.loadSessionFused(fr.NewID)
	if err != nil {
		t.Fatal(err)
	}
	// Plain fork includes the boundary turn (user+assistant of turn 2).
	if len(plain.Messages) != 4 {
		t.Fatalf("plain fork must include the boundary turn (4 rows), got %d", len(plain.Messages))
	}
	// fork_and_resend at turn 2: prefix ABOVE (turn 1 only) + new row.
	reply := make(chan any, 1)
	a.onForkAndResend(forkAndResendMsg{TurnID: 2, Text: "FORK MSG", Reply: reply})
	r := (<-reply).(forkResendResult)
	if r.Error != "" {
		t.Fatal(r.Error)
	}
	forked, _, err := st.loadSessionFused(r.NewID)
	if err != nil {
		t.Fatal(err)
	}
	if len(forked.Messages) != 3 {
		t.Fatalf("fork_and_resend: turn-1 rows (2) + new row = 3, got %d", len(forked.Messages))
	}
	last := forked.Messages[len(forked.Messages)-1]
	ok := false
	for _, c := range last.Content {
		if tb, ok2 := c.(provider.TextBlock); ok2 && tb.Text == "FORK MSG" {
			ok = true
		}
	}
	if !ok {
		t.Fatalf("fork_and_resend lost the text: %+v", last.Content)
	}
	if last.Role != provider.RoleUser {
		t.Fatal("new row must be the user row")
	}
}

// Fork inherits TERMINAL bg tasks (history); running ones stay with the
// owner session.
func TestForkInheritsTerminalBgTasks(t *testing.T) {
	rec := &SessionRecord{ID: "sess1", Messages: darMsgs(4)}
	a, st := darActor(t, rec)
	a.onBgTaskRegister(bgTaskRegisterMsg{JobID: "bg_done", Kind: "bash", Label: "finished"})
	a.onBgTaskFinish(bgTaskFinishMsg{JobID: "bg_done", Status: BgStatusDone})
	a.onBgTaskRegister(bgTaskRegisterMsg{JobID: "bg_run", Kind: "bash", Label: "running"})
	fch := make(chan any, 1)
	a.onFork(forkReqMsg{Keep: 3, Title: "t", Reply: fch})
	fr := (<-fch).(forkResult)
	if fr.Error != "" {
		t.Fatal(fr.Error)
	}
	forked, _, err := st.loadSessionFused(fr.NewID)
	if err != nil {
		t.Fatal(err)
	}
	if len(forked.BgTasks) != 1 || forked.BgTasks[0].ID != "bg_done" {
		t.Fatalf("fork must inherit terminal bg tasks only: %+v", forked.BgTasks)
	}
	if !strings.Contains(forked.BgTasks[0].Status, "done") {
		t.Fatalf("inherited task must keep its status: %q", forked.BgTasks[0].Status)
	}
}