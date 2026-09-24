package main

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func testBG(t *testing.T) *bgSupervisor {
	t.Helper()
	b := newBGSupervisor(t.TempDir())
	b.emit = func(any) {}
	b.hostID = func() string { return "h" }
	var wg sync.WaitGroup
	wg.Add(1)
	go b.run(&wg)
	t.Cleanup(func() {
		b.control <- shutdownMsg{}
		wg.Wait()
	})
	return b
}

func bgRegister(t *testing.T, b *bgSupervisor, session, label string) bgRegisterResult {
	t.Helper()
	reply := make(chan any, 1)
	b.inbox <- Envelope{Payload: bgRegisterMsg{Kind: "bash", SessionID: session, Label: label, Reply: reply}}
	select {
	case r := <-reply:
		return r.(bgRegisterResult)
	case <-time.After(3 * time.Second):
		t.Fatalf("register timeout")
		return bgRegisterResult{}
	}
}

func bgList(t *testing.T, b *bgSupervisor) []map[string]any {
	t.Helper()
	reply := make(chan any, 1)
	b.inbox <- Envelope{Payload: bgListMsg{Reply: reply}}
	select {
	case r := <-reply:
		return r.([]map[string]any)
	case <-time.After(3 * time.Second):
		t.Fatalf("list timeout")
		return nil
	}
}

func TestBgRegisterFinish(t *testing.T) {
	b := testBG(t)
	reg := bgRegister(t, b, "s1", "echo hi")
	rows := bgList(t, b)
	if len(rows) != 1 || rows[0]["status"] != BgStatusRunning {
		t.Fatalf("want 1 running, got %+v", rows)
	}
	b.inbox <- Envelope{Payload: bgFinishMsg{JobID: reg.JobID, Status: BgStatusDone, Result: "hi"}}
	deadline := time.Now().Add(3 * time.Second)
	for {
		rows = bgList(t, b)
		if rows[0]["status"] == BgStatusDone {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never finished: %+v", rows)
		}
		time.Sleep(10 * time.Millisecond)
	}
	select {
	case <-reg.Done:
	case <-time.After(3 * time.Second):
		t.Fatalf("done never closed")
	}
}

func TestBgCancelBeatsFinish(t *testing.T) {
	b := testBG(t)
	reg := bgRegister(t, b, "s1", "sleep 99")
	creply := make(chan any, 1)
	b.inbox <- Envelope{Payload: bgCancelMsg{JobID: reg.JobID, By: "user", Reply: creply}}
	if ok := (<-creply).(bool); !ok {
		t.Fatalf("cancel failed")
	}
	// Late finish loses.
	b.inbox <- Envelope{Payload: bgFinishMsg{JobID: reg.JobID, Status: BgStatusDone, Result: "late"}}
	rows := bgList(t, b)
	if rows[0]["status"] != BgStatusCancelled {
		t.Fatalf("cancel lost to late finish: %+v", rows)
	}
}

func TestBgSleepWakePush(t *testing.T) {
	b := testBG(t)
	reg := bgRegister(t, b, "s1", "sleep 99")
	wake := b.subscribeFinish("s1", nil)
	select {
	case <-wake:
		t.Fatalf("woke with job still running")
	case <-time.After(100 * time.Millisecond):
	}
	b.inbox <- Envelope{Payload: bgFinishMsg{JobID: reg.JobID, Status: BgStatusDone, Result: "x"}}
	select {
	case <-wake:
	case <-time.After(3 * time.Second):
		t.Fatalf("sleep never woke on finish")
	}
}

func TestBgFreshnessGrace(t *testing.T) {
	b := testBG(t)
	reg := bgRegister(t, b, "s1", "quick")
	b.inbox <- Envelope{Payload: bgFinishMsg{JobID: reg.JobID, Status: BgStatusDone, Result: "x"}}
	time.Sleep(50 * time.Millisecond)
	// A new sleep right after finish wakes immediately (60s grace).
	wake := b.subscribeFinish("s1", nil)
	select {
	case <-wake:
	case <-time.After(3 * time.Second):
		t.Fatalf("freshness grace did not wake")
	}
}

func TestBgPidfileReadopt(t *testing.T) {
	dir := t.TempDir()
	b := newBGSupervisor(dir)
	b.emit = func(any) {}
	b.hostID = func() string { return "h" }
	var wg sync.WaitGroup
	wg.Add(1)
	go b.run(&wg)

	// Live pid: ourselves.
	reply := make(chan any, 1)
	b.inbox <- Envelope{Payload: bgRegisterMsg{Kind: "bash", SessionID: "s1", Label: "live", PID: os.Getpid(), Reply: reply}}
	reg := (<-reply).(bgRegisterResult)
	if _, err := os.Stat(filepath.Join(dir, "bg", reg.JobID+".pid.json")); err != nil {
		t.Fatalf("no pidfile: %v", err)
	}
	b.control <- shutdownMsg{}
	wg.Wait()

	// Restart: same dir, must re-adopt the live job (no re-run).
	b2 := newBGSupervisor(dir)
	b2.emit = func(any) {}
	b2.hostID = func() string { return "h" }
	var wg2 sync.WaitGroup
	wg2.Add(1)
	go b2.run(&wg2)
	defer func() { b2.control <- shutdownMsg{}; wg2.Wait() }()
	time.Sleep(200 * time.Millisecond)
	rows := func() []map[string]any {
		r := make(chan any, 1)
		b2.inbox <- Envelope{Payload: bgListMsg{Reply: r}}
		return (<-r).([]map[string]any)
	}()
	found := false
	for _, row := range rows {
		if row["id"] == reg.JobID && row["status"] == BgStatusRunning {
			found = true
		}
	}
	if !found {
		t.Fatalf("live job not re-adopted: %+v", rows)
	}
}

func TestBgPidfileOrphan(t *testing.T) {
	dir := t.TempDir()
	b := newBGSupervisor(dir)
	b.emit = func(any) {}
	b.hostID = func() string { return "h" }
	var wg sync.WaitGroup
	wg.Add(1)
	go b.run(&wg)
	// Dead pid: impossible pid.
	reply := make(chan any, 1)
	b.inbox <- Envelope{Payload: bgRegisterMsg{Kind: "bash", SessionID: "s1", Label: "dead", PID: 1<<30, Reply: reply}}
	reg := (<-reply).(bgRegisterResult)
	b.control <- shutdownMsg{}
	wg.Wait()

	b2 := newBGSupervisor(dir)
	b2.emit = func(any) {}
	b2.hostID = func() string { return "h" }
	var wg2 sync.WaitGroup
	wg2.Add(1)
	go b2.run(&wg2)
	defer func() { b2.control <- shutdownMsg{}; wg2.Wait() }()
	time.Sleep(200 * time.Millisecond)
	r := make(chan any, 1)
	b2.inbox <- Envelope{Payload: bgListMsg{Reply: r}}
	rows := (<-r).([]map[string]any)
	for _, row := range rows {
		if row["id"] == reg.JobID {
			if row["status"] != BgStatusOrphaned {
				t.Fatalf("want orphaned, got %+v", row)
			}
			return
		}
	}
	t.Fatalf("orphan missing: %+v", rows)
}
