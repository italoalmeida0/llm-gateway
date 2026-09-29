package main

import (
	"context"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestQueueSendNowSteeringDuringTurn(t *testing.T) {
	workerStarted := make(chan struct{})
	release := make(chan struct{})
	worker := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		close(workerStarted)
		select {
		case <-release:
			env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}}
		case <-ctx.Done():
			env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen, cancelled: true}}
		}
	}

	act, _, _, stop := newTestActor(t, newTestRecord("steer-s1"), worker)
	defer stop()

	// 1. Start initial turn
	r1 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "first prompt", Reply: r1}}
	res1 := (<-r1).(promptResult)
	if !res1.Accepted || res1.Queued {
		t.Fatalf("first prompt should start turn: %+v", res1)
	}

	select {
	case <-workerStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("worker did not start in time")
	}

	// 2. Queue a message while turn is running
	r2 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "steering message", Reply: r2}}
	res2 := (<-r2).(promptResult)
	if !res2.Accepted || !res2.Queued {
		t.Fatalf("second prompt should be queued: %+v", res2)
	}

	// Verify queue item exists
	repCh := make(chan any, 1)
	act.control <- watchdogPingMsg{Reply: repCh}
	rep := (<-repCh).(watchdogReport)
	if rep.State != stateRunning {
		t.Fatalf("actor should be running, got %s", rep.State)
	}

	// Read queue item ID via hook
	var queueID string
	idGot := make(chan struct{})
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		if len(act.rec.Queue) > 0 {
			queueID = act.rec.Queue[0].ID
		}
		close(idGot)
	}}}
	<-idGot
	if queueID == "" {
		t.Fatal("no queued item found")
	}

	// 3. User clicks Send Now on the queued message
	act.inbox <- Envelope{Payload: queueSendNowMsg{QueueID: queueID}}

	// Wait for queueSendNowMsg to be processed
	pingProcessed := make(chan struct{})
	act.inbox <- Envelope{Payload: hookMsg{fn: func() { close(pingProcessed) }}}
	<-pingProcessed

	// 4. Verify turn is STILL RUNNING (not cancelled!) and sendNow is true
	act.control <- watchdogPingMsg{Reply: repCh}
	rep = (<-repCh).(watchdogReport)
	if rep.State != stateRunning {
		t.Fatalf("turn must remain running on Send Now, got state=%s", rep.State)
	}

	var sendNowVal bool
	hookDone := make(chan struct{})
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		sendNowVal = act.sendNow
		close(hookDone)
	}}}
	<-hookDone
	if !sendNowVal {
		t.Fatal("act.sendNow should be true after onQueueSendNow")
	}

	// 5. Worker simulates BeforeRequest by sending workerRefreshMsg
	refreshReply := make(chan any, 1)
	act.inbox <- Envelope{Payload: workerRefreshMsg{gen: 1, Reply: refreshReply}}

	refResRaw := <-refreshReply
	refRes, ok := refResRaw.(workerRefreshResult)
	if !ok || refRes.stale {
		t.Fatalf("refresh result stale or invalid: %+v", refResRaw)
	}

	// Verify the steering message was injected into context
	if len(refRes.context) != 1 {
		t.Fatalf("expected 1 injected context message, got %d", len(refRes.context))
	}
	steerMsg := refRes.context[0]
	if steerMsg.Role != provider.RoleUser {
		t.Fatalf("expected role user, got %s", steerMsg.Role)
	}
	if len(steerMsg.Content) == 0 {
		t.Fatal("empty content in steering message")
	}
	tb, ok := steerMsg.Content[0].(provider.TextBlock)
	if !ok || tb.Text != "steering message" {
		t.Fatalf("expected 'steering message', got %+v", steerMsg.Content[0])
	}
	if steerMsg.Meta["steering"] != "true" {
		t.Fatalf("expected steering=true meta, got %v", steerMsg.Meta)
	}

	// Verify the queue is now empty and sendNow is false
	hookDone2 := make(chan struct{})
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		if len(act.rec.Queue) != 0 {
			t.Errorf("queue should be empty, len=%d", len(act.rec.Queue))
		}
		if act.sendNow {
			t.Errorf("act.sendNow should be false after consumption")
		}
		close(hookDone2)
	}}}
	<-hookDone2

	// 6. Finish worker normally
	close(release)
}

func TestQueueSendNowFallthroughWhenNoRefresh(t *testing.T) {
	workerStarted := make(chan struct{})
	finishWorker := make(chan struct{})
	var curGen int
	worker := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		curGen = snap.gen
		select {
		case workerStarted <- struct{}{}:
		default:
		}
		select {
		case <-finishWorker:
			env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}}
		case <-ctx.Done():
			env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen, cancelled: true}}
		}
	}

	act, _, _, stop := newTestActor(t, newTestRecord("steer-s2"), worker)
	defer stop()

	// 1. Start initial turn
	r1 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "turn 1", Reply: r1}}
	<-r1
	<-workerStarted

	// 2. Queue message
	r2 := make(chan any, 1)
	act.inbox <- Envelope{Payload: userPromptMsg{Text: "queued follow-up", Reply: r2}}
	<-r2

	// Get queue ID
	var queueID string
	idDone := make(chan struct{})
	act.inbox <- Envelope{Payload: hookMsg{fn: func() {
		queueID = act.rec.Queue[0].ID
		close(idDone)
	}}}
	<-idDone

	// 3. Send Now
	act.inbox <- Envelope{Payload: queueSendNowMsg{QueueID: queueID}}

	// 4. Worker finishes without calling BeforeRequest/workerRefreshMsg
	finishWorker <- struct{}{}

	// 5. finishTurn should automatically promote queue head to turn 2
	select {
	case <-workerStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("turn 2 was not started automatically")
	}

	if curGen != 2 {
		t.Fatalf("expected gen 2, got %d", curGen)
	}

	finishWorker <- struct{}{}
}

func TestQueueSendNowWhenIdleStartsTurn(t *testing.T) {
	workerStarted := make(chan struct{})
	worker := func(snap workerSnapshot, env workerEnv, ctx context.Context) {
		close(workerStarted)
		env.inbox <- Envelope{Payload: workerFinishedMsg{gen: snap.gen}}
	}

	act, _, _, stop := newTestActor(t, newTestRecord("steer-s3"), worker)
	defer stop()

	// Add item to queue directly
	act.rec.Queue = []QueuedMessage{
		{ID: "q1", Text: "send me when idle", CreatedAt: time.Now().UnixMilli()},
	}

	// Send queueSendNowMsg while idle
	act.inbox <- Envelope{Payload: queueSendNowMsg{QueueID: "q1"}}

	// Should start turn immediately
	select {
	case <-workerStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("turn was not started immediately when idle")
	}
}
