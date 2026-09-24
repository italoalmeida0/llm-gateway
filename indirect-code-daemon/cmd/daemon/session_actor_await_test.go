package main

import (
	"context"
	"testing"
	"time"
)

// driveAwait puts the actor into awaiting* by simulating what the worker
// does: it must run on the actor goroutine, so we send a test-only message.
type testEnterAwaitMsg struct {
	kind        string
	id          string
	recommended [][]string
}

func TestApprovalTimeoutCancelsTurn(t *testing.T) {
	rec := newTestRecord("s4")
	dir := t.TempDir()
	store := newDiskStore(dir)
	wsCh := make(chan any, 64)
	act := newSessionActor(rec.ID, rec, store, func(ev any) { wsCh <- ev }, nil, nil)
	release := make(chan struct{})
	act.startWorker = func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		select {
		case <-release:
			env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}, Epoch: snap.epoch}
		case <-ctx.Done():
			env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen, cancelled: true}, Epoch: snap.epoch}
		}
	}
	// startWorker assigned before run: happens-before via goroutine start.
	go act.run()
	defer func() { act.control <- shutdownMsg{}; <-act.done }()

	r1 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "run", Reply: r1}}
	if res := (<-r1).(promptResult); !res.Accepted {
		t.Fatalf("not accepted: %+v", res)
	}
	// Enter awaitingApproval with a tiny deadline by shrinking awaitTimeout
	// through direct state manipulation on the actor goroutine.
	entered := make(chan string, 1)
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		act.enterAwait("approval", "ap1", nil)
		// shrink the armed timer to fire fast
		act.pending.timer.Stop()
		act.pending.timer = time.AfterFunc(50*time.Millisecond, func() {
			select {
			case act.inbox <- Envelope{Payload: stateTimeoutMsg{ID: "ap1"}}:
			default:
				select {
				case act.control <- stateTimeoutMsg{ID: "ap1"}:
				default:
				}
			}
		})
		entered <- act.pending.id
	}}}
	if id := <-entered; id != "ap1" {
		t.Fatalf("no await entered")
	}
	// Wait for cancel: state returns to idle (worker got ctx.Done).
	deadline := time.Now().Add(3 * time.Second)
	for {
		repCh := make(chan any, 1)
		act.control <- watchdogPingMsg{Reply: repCh}
		if rep := (<-repCh).(watchdogReport); rep.State == stateIdle {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("approval timeout did not cancel the turn")
		}
		time.Sleep(20 * time.Millisecond)
	}
	close(release)
	// Queue must be intact (empty here, no error) and a notice emitted.
	found := false
	timeout := time.After(2 * time.Second)
	for !found {
		select {
		case ev := <-wsCh:
			if m, ok := ev.(map[string]any); ok && m["type"] == "system_notice" {
				found = true
			}
		case <-timeout:
			t.Fatalf("no timeout notice emitted")
		}
	}
}

// testHookMsg runs fn on the actor goroutine (test only).
type testHookMsg struct {
	fn func()
}

