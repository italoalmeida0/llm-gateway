package main

import (
	"context"
	"sync"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

// TestStaleWorkerWALAppendRejectedAfterQuarantine (B1): a quarantined
// worker keeps its epoch. After a fresh prompt recovers the session (gen
// bumped, epoch unchanged), the zombie's late WAL append must NOT land in
// the new turn's record/WAL. Before the gen gate this corrupted the new
// turn durably.
func TestStaleWorkerWALAppendRejectedAfterQuarantine(t *testing.T) {
	release := make(chan struct{})
	var oldEnv workerEnv
	var oldSnap workerSnapshot
	var capMu sync.Mutex
	captured := false
	stuck := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		capMu.Lock()
		if !captured {
			// Capture ONLY the first (pre-quarantine) incarnation; the
			// recovery turn re-invokes this stub and must not overwrite it.
			oldEnv, oldSnap, captured = env, snap, true
		}
		capMu.Unlock()
		<-release // ignores ctx
	}
	act, _, _, stop := newTestActor(t, newTestRecord("b1"), stuck)
	defer stop()

	r1 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "work", Reply: r1}}
	if res := (<-r1).(promptResult); !res.Accepted {
		t.Fatalf("not accepted: %+v", res)
	}

	// Quarantine through the real ladder.
	done := make(chan struct{})
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		act.cancelRounds = maxCancelRounds
		act.doCancel("watchdog_quarantine")
		close(done)
	}}}
	<-done
	repCh := make(chan any, 1)
	act.control <- watchdogPingMsg{Reply: repCh}
	if rep := (<-repCh).(watchdogReport); rep.State != stateOrphaned {
		t.Fatalf("want orphaned, got %s", rep.State)
	}

	// Fresh prompt recovers: new gen, same epoch.
	r2 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "again", Reply: r2}}
	if res := (<-r2).(promptResult); !res.Accepted || res.Queued {
		t.Fatalf("recovery prompt should start a turn: %+v", res)
	}

	// Zombie worker wakes and appends with its OLD gen (same epoch).
	capMu.Lock()
	zEnv, zSnap := oldEnv, oldSnap
	capMu.Unlock()
	stale := provider.Message{Role: provider.RoleAssistant, TurnIndex: zSnap.turnIndex,
		Content: []provider.Content{provider.TextBlock{Text: "STALE-FROM-OLD-WORKER"}}}
	zEnv.inbox <- Envelope{Payload: walAppendMsg{gen: zSnap.gen, ev: walMsgEvent(stale)}, Epoch: zSnap.epoch}
	time.Sleep(200 * time.Millisecond)

	rep := make(chan any, 1)
	act.inbox <- Envelope{Payload: readReqMsg{What: "session", Reply: rep}}
	rec := (<-rep).(readResult).Payload.(*SessionRecord)
	for _, m := range rec.Messages {
		for _, c := range m.Content {
			if tb, ok := c.(provider.TextBlock); ok && tb.Text == "STALE-FROM-OLD-WORKER" {
				t.Fatalf("stale worker append leaked into the new turn (turnIndex=%d)", m.TurnIndex)
			}
		}
	}
	close(release)
}

// TestApprovalTimeoutKeepsBackloggedMail (B2): the timeout path must not
// drain the inbox. A walAppendMsg sitting behind the timeout used to be
// consumed and lost.
func TestApprovalTimeoutKeepsBackloggedMail(t *testing.T) {
	act, _, _, stop := newTestActor(t, newTestRecord("b2"), nil)
	defer stop()

	done := make(chan struct{})
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		act.state = stateRunning
		act.gen = 1
		act.workerDone = make(chan struct{})
		act.enterAwait("approval", "ap1", nil)
		close(done)
	}}}
	<-done

	msg := provider.Message{Role: provider.RoleAssistant, TurnIndex: 1,
		Content: []provider.Content{provider.TextBlock{Text: "IMPORTANT-ASSISTANT-TEXT"}}}
	// Order: [timeout-runner, walAppend] — the drain used to eat the append.
	act.inbox <- Envelope{Payload: hookMsg{fn: func() { act.onStateTimeout(stateTimeoutMsg{ID: "ap1"}) }}}
	act.inbox <- Envelope{Payload: walAppendMsg{gen: 1, ev: walMsgEvent(msg)}}
	time.Sleep(400 * time.Millisecond)

	rep := make(chan any, 1)
	act.inbox <- Envelope{Payload: readReqMsg{What: "session", Reply: rep}}
	rec := (<-rep).(readResult).Payload.(*SessionRecord)
	for _, m := range rec.Messages {
		for _, c := range m.Content {
			if tb, ok := c.(provider.TextBlock); ok && tb.Text == "IMPORTANT-ASSISTANT-TEXT" {
				return
			}
		}
	}
	t.Fatalf("approval-timeout drain lost a transcript append (state=%s)", rec.Status)
}

// TestApprovalTimeoutDoesNotEatWorkerFinish (B2): a workerFinishedMsg behind
// the timeout used to be consumed, wedging the session in `cancelling`.
func TestApprovalTimeoutDoesNotEatWorkerFinish(t *testing.T) {
	act, _, _, stop := newTestActor(t, newTestRecord("b2b"), nil)
	defer stop()

	done := make(chan struct{})
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		act.state = stateRunning
		act.gen = 1
		act.workerDone = make(chan struct{})
		act.enterAwait("approval", "ap1", nil)
		close(done)
	}}}
	<-done

	act.inbox <- Envelope{Payload: hookMsg{fn: func() { act.onStateTimeout(stateTimeoutMsg{ID: "ap1"}) }}}
	act.inbox <- Envelope{Payload: workerFinishedMsg{gen: 1, cancelled: true}}
	time.Sleep(400 * time.Millisecond)

	repCh := make(chan any, 1)
	act.control <- watchdogPingMsg{Reply: repCh}
	if rep := (<-repCh).(watchdogReport); rep.State == stateCancel {
		t.Fatalf("session wedged in %s: the timeout path ate workerFinishedMsg", rep.State)
	}
}

// TestResidentBytesCountsToolResults (B3): the LRU budget must see nested
// tool-result content and images, not just top-level text.
func TestResidentBytesCountsToolResults(t *testing.T) {
	big := make([]byte, 2_000_000)
	for i := range big {
		big[i] = 'x'
	}
	rec := &SessionRecord{ID: "b3"}
	rec.Messages = append(rec.Messages, provider.Message{
		Role: provider.RoleTool,
		Content: []provider.Content{
			provider.ToolResultBlock{CallID: "c1", Content: []provider.Content{provider.TextBlock{Text: string(big)}}},
		},
	})
	rec.Messages = append(rec.Messages, provider.Message{
		Role:    provider.RoleUser,
		Content: []provider.Content{provider.ImageBlock{MimeType: "image/png", Data: big}},
	})
	est := estimateResidentBytes(rec)
	if est < int64(2*len(big)) {
		t.Fatalf("estimate %d does not cover 2x%d bytes of nested content", est, len(big))
	}
}

// TestSlashReplySeedsTurn: /help parity — a deterministic user/assistant
// pair with no model call, persisted and pushed to clients.
func TestSlashReplySeedsTurn(t *testing.T) {
	act, store, wsCh, stop := newTestActor(t, newTestRecord("b4"), nil)
	defer stop()

	ack := make(chan any, 1)
	act.inbox <- Envelope{Payload: slashReplyMsg{Command: "/help", Reply: "Commands: /clear", Ack: ack}}
	select {
	case <-ack:
	case <-time.After(2 * time.Second):
		t.Fatalf("slash reply never acked")
	}

	rep := make(chan any, 1)
	act.inbox <- Envelope{Payload: readReqMsg{What: "session", Reply: rep}}
	rec := (<-rep).(readResult).Payload.(*SessionRecord)
	if len(rec.Messages) != 2 {
		t.Fatalf("want 2 messages, got %d", len(rec.Messages))
	}
	if rec.Messages[0].Role != provider.RoleUser || rec.Messages[1].Role != provider.RoleAssistant {
		t.Fatalf("want user+assistant, got %s+%s", rec.Messages[0].Role, rec.Messages[1].Role)
	}
	if rec.Messages[0].TurnIndex != rec.Messages[1].TurnIndex {
		t.Fatalf("pair must share a turn index")
	}
	// Persisted (idle path saves directly).
	if _, err := store.loadSession(rec.ID); err != nil {
		t.Fatalf("slash reply not persisted: %v", err)
	}
	// Pushed to clients.
	select {
	case ev := <-wsCh:
		if m, ok := ev.(map[string]any); !ok || m["type"] != "session_content" {
			t.Fatalf("expected session_content push, got %v", ev)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("no session_content emitted")
	}
}
