package main

import (
	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/runner"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRecoveryNoticeRetryStillRequiresPersistence(t *testing.T) {
	a := reviewActor(t)
	a.state, a.rec.Status = stateRunning, "running"
	a.bg = newBGSupervisor(a.store.dataDir)
	path := a.store.sessionFile(a.id)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	notice := bgNoticeMsg{JobID: "not-durable", Text: "completed", Finished: true}
	a.onBgNotice(notice)
	if a.persistErr == nil {
		t.Fatal("persistence failure was not injected")
	}
	if len(a.bg.inbox) != 0 {
		t.Fatal("first failed save was acknowledged")
	}
	a.onBgNotice(notice)
	select {
	case env := <-a.bg.inbox:
		if ack, ok := env.Payload.(bgAckMsg); ok && ack.JobID == notice.JobID {
			t.Fatal("second delivery acknowledged the RAM identity while storage was still failing")
		}
	default:
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	a.onBgNotice(notice)
	select {
	case env := <-a.bg.inbox:
		if ack, ok := env.Payload.(bgAckMsg); !ok || ack.JobID != notice.JobID {
			t.Fatal("successful retry did not acknowledge the original notice")
		}
	default:
		t.Fatal("successful retry was not acknowledged")
	}
	a.onBgNotice(notice)
	rec, err := a.store.loadSession(a.id)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, msg := range rec.Messages {
		if msg.Meta["background_delivery"] == notice.JobID {
			count++
		}
	}
	if count != 1 || len(a.pendingContext) != 1 {
		t.Fatalf("retry duplicated delivery: persisted=%d pending=%d", count, len(a.pendingContext))
	}
}

func TestRecoveryResyncRetainedWhenSnapshotBusy(t *testing.T) {
	a := reviewActor(t)
	ws := newWSActor()
	sup := newSessionSupervisor(a.store.dataDir, a.supCfg, nil, nil)
	sup.resident[a.id] = &residentEntry{handle: &sessionHandle{inbox: a.inbox, control: a.control, done: a.done}}
	server := newWSServer(a.store.dataDir, a.supCfg, sup, nil, nil, nil, ws)
	ws.resync[a.id] = true
	// A resident actor that cannot answer its snapshot within replyTimeout.
	server.scheduleResyncFlush()
	waitFor(t, replyTimeout+2*time.Second, func() bool { return !server.resyncFlush.Load() })
	if !ws.hasResyncs() {
		t.Fatal("a transient snapshot timeout discarded the pending resync")
	}
	// Resume the actor with an idle socket: no outbound traffic should be
	// necessary to trigger a new snapshot attempt.
	sent := make(chan any, 8)
	ws.send = func(ev any) error { sent <- ev; return nil }
	go a.run()
	var wg sync.WaitGroup
	wg.Add(1)
	go ws.run(&wg)
	t.Cleanup(func() {
		ws.control <- shutdownMsg{}
		wg.Wait()
		server.waitForLanes()
		a.control <- shutdownMsg{}
		<-a.done
	})
	select {
	case ev := <-sent:
		m, ok := ev.(map[string]any)
		if !ok || m["type"] != "session_data" || m["sessionId"] != a.id {
			t.Fatal("retry did not restore the session snapshot")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("idle socket never retried its pending repair")
	}
}

func TestRecoveryCancelPersistenceFailureKeepsJobRunning(t *testing.T) {
	root, dataDir := runnerTestRoot(t)
	b := newBGSupervisor(dataDir)
	stopped := false
	b.jobs["job"] = &bgJob{ID: "job", Runner: true, Status: BgStatusRunning, stop: func() { stopped = true }}
	if err := os.WriteFile(runner.RunnersDir(root), []byte("blocked"), 0o600); err != nil {
		t.Fatal(err)
	}
	if b.onCancel("job", "assistant") || stopped || b.jobs["job"].Status != BgStatusRunning {
		t.Fatal("cancel proceeded without durably recording suppression")
	}
}

func TestRecoveryTerminalRecoveryUsesReadableBrainLog(t *testing.T) {
	root, dataDir := runnerTestRoot(t)
	proc := spawnTestRunner(t, root, dataDir, "echo completed")
	if err := proc.Wait(); err != nil {
		t.Fatal(err)
	}
	if err := runner.WriteDisposition(root, proc.JobID, runner.DispBackground); err != nil {
		t.Fatal(err)
	}
	seedSession(t, dataDir, "sess1", proc.JobID)
	b := newBGSupervisor(dataDir)
	b.adoptRunners()
	notice := b.notices[proc.JobID]
	if notice == nil {
		t.Fatal("missing retained notice")
	}
	sandbox := tools.NewSandbox(t.TempDir())
	sandbox.AllowExtra(filepath.Dir(proc.BrainLog))
	sandbox.Lock()
	if err := sandbox.CheckPath(proc.BrainLog); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(notice.Text, proc.BrainLog) {
		t.Fatalf("boot recovery still points at the live log instead of the brain copy; live-log access: %v", sandbox.CheckPath(proc.LogPath))
	}
}
