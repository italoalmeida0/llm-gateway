package main

// Regression tests for the background-task and fork&resend fixes:
//  1. A task finish must reach the session actor even when its inbox is
//     temporarily full (durable delivery, ordered after recovery).
//  2. An ack naming another session must NOT retire this session's notice.
//  3. A chunk for a lost task record rebuilds it from the runner state.
//  4. fork&resend reports a failed turn start instead of claiming success.

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/runner"
)

// BUG-BG-01 regression: sessionInboxDurable retries under mailbox pressure
// instead of dropping the terminal transition.
func TestBgFinishSurvivesFullInbox(t *testing.T) {
	b := newBGSupervisor(t.TempDir())
	inbox := make(chan Envelope, 1)
	b.session = func(string) (chan Envelope, chan any, bool) { return inbox, nil, true }
	// Fill the mailbox so the first attempts fail.
	inbox <- Envelope{SessionID: "s1"}
	b.sessionInboxDurable("s1", bgTaskFinishMsg{JobID: "j1", Status: BgStatusDone})
	// Drain the blocking envelope after a moment: the durable delivery must
	// still land (bounded retry, not a best-effort drop).
	time.Sleep(150 * time.Millisecond)
	<-inbox
	deadline := time.Now().Add(5 * time.Second)
	for {
		select {
		case env := <-inbox:
			if _, ok := env.Payload.(bgTaskFinishMsg); ok {
				return // delivered despite the full inbox
			}
		default:
			if time.Now().After(deadline) {
				t.Fatal("finish was dropped under mailbox pressure")
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
}

// BUG-BG-02 regression: an ack from another session must not retire the
// notice (and must not trigger cleanup of a live runner identity).
func TestBgAckRejectsForeignSession(t *testing.T) {
	b := newBGSupervisor(t.TempDir())
	b.session = func(string) (chan Envelope, chan any, bool) { return nil, nil, false }
	n := b.retainNotice("j1", "owner-session", "done", true)
	if n == nil {
		t.Fatal("notice not retained")
	}
	b.onAck(bgAckMsg{JobID: "j1", SessionID: "intruder"})
	if _, ok := b.notices["j1"]; !ok {
		t.Fatal("foreign ack retired another session's notice")
	}
	b.onAck(bgAckMsg{JobID: "j1", SessionID: "owner-session"})
	if _, ok := b.notices["j1"]; ok {
		t.Fatal("owner ack did not retire the notice")
	}
	// Legacy/anonymous acks (no session) still work for internal senders.
	b.retainNotice("j2", "owner-session", "done", true)
	b.onAck(bgAckMsg{JobID: "j2"})
	if _, ok := b.notices["j2"]; ok {
		t.Fatal("anonymous ack should still retire (internal sender)")
	}
}

// BUG-BG-03 regression: a chunk whose task record was lost rebuilds the
// record from the runner's durable state instead of silently dropping.
func TestOrphanChunkRebuildsTaskFromRunnerState(t *testing.T) {
	a, store := darActor(t, &SessionRecord{ID: "orphan"})
	log := filepath.Join(t.TempDir(), "out.log")
	if err := os.WriteFile(log, []byte("chunk-a\n"), 0600); err != nil {
		t.Fatal(err)
	}
	st := &runner.State{JobID: "job-orphan", SessionID: a.id, Kind: "bash", Label: "cmd",
		LogPath: log, Status: runner.StatusRunning, StartedAt: 1}
	root := store.rootDir()
	if err := runner.WriteState(root, st); err != nil {
		t.Fatal(err)
	}
	if err := runner.WriteDisposition(root, st.JobID, runner.DispBackground); err != nil {
		t.Fatal(err)
	}
	// The record has NO task entry (meta rewrite lost it): the chunk must
	// rebuild it via restoreRunnerTask instead of vanishing.
	a.onBgTaskChunk(bgTaskChunkMsg{JobID: "job-orphan", Text: "chunk-b\n"})
	if i := findBgTask(a.rec, "job-orphan"); i < 0 {
		t.Fatal("orphan chunk dropped: task record was not rebuilt from runner state")
	}
}

// BUG-FORK-01 regression: when the fork's turn cannot start, the reply must
// say so (with the fork id) instead of reporting plain success.
func TestForkResendReportsStartFailure(t *testing.T) {
	a, st := darActor(t, &SessionRecord{ID: "sess1", Messages: darMsgs(4), TurnSeq: 2})
	// Route exists but the fork's actor never answers seededStartMsg.
	a.routeFn = func(string) (chan Envelope, chan any, bool) {
		return make(chan Envelope), nil, true // nobody reads it
	}
	old := replyTimeout
	replyTimeout = 50 * time.Millisecond
	defer func() { replyTimeout = old }()

	reply := make(chan any, 1)
	a.onForkAndResend(forkAndResendMsg{TurnID: 2, Text: "forked", Reply: reply})
	r := (<-reply).(forkResendResult)
	if r.Error == "" {
		t.Fatal("fork&resend claimed success although the turn never started")
	}
	if r.NewID == "" {
		t.Fatal("start failure must still report the durable fork id")
	}
	// The fork's user row is durable either way.
	if _, err := st.loadSession(r.NewID); err != nil {
		t.Fatalf("fork lost despite start failure: %v", err)
	}
}

// The happy path still answers success AFTER the start is accepted.
func TestForkResendReportsSuccessAfterStart(t *testing.T) {
	a, st := darActor(t, &SessionRecord{ID: "sess1", Messages: darMsgs(4), TurnSeq: 2})
	started := make(chan struct{})
	a.routeFn = func(id string) (chan Envelope, chan any, bool) {
		inbox := make(chan Envelope, 4)
		go func() {
			for env := range inbox {
				if m, ok := env.Payload.(seededStartMsg); ok {
					m.Reply <- seededStartResult{}
					close(started)
				}
			}
		}()
		return inbox, nil, true
	}
	reply := make(chan any, 1)
	a.onForkAndResend(forkAndResendMsg{TurnID: 2, Text: "forked", Reply: reply})
	r := (<-reply).(forkResendResult)
	if r.Error != "" {
		t.Fatalf("happy path reported error: %s", r.Error)
	}
	if r.NewID == "" {
		t.Fatal("missing fork id")
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("seededStartMsg never reached the fork")
	}
	if _, err := st.loadSession(r.NewID); err != nil {
		t.Fatal(err)
	}
}

// answeringForkRoute is a routeFn stub whose fork actor accepts the seeded
// start and answers immediately (the supervisor spawns real actors in
// production; unit tests only need the reply contract).
func answeringForkRoute() func(id string) (chan Envelope, chan any, bool) {
	return func(string) (chan Envelope, chan any, bool) {
		inbox := make(chan Envelope, 8)
		go func() {
			for env := range inbox {
				if m, ok := env.Payload.(seededStartMsg); ok && m.Reply != nil {
					m.Reply <- seededStartResult{}
				}
			}
		}()
		return inbox, nil, true
	}
}
