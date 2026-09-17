package main

import (
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func evictTestSession(d *DaemonServer, id string, msgs int) *ActiveSession {
	rec := &SessionRecord{ID: id, CWD: "/tmp", Title: id, Model: "m", Status: "idle"}
	for i := 0; i < msgs; i++ {
		rec.Messages = append(rec.Messages, provider.Message{Role: provider.RoleUser, TurnIndex: i + 1})
	}
	if err := d.saveSession(rec); err != nil {
		panic(err)
	}
	act, err := d.getOrCreateActiveSession(id)
	if err != nil {
		panic(err)
	}
	return act
}

// Idle sessions past the cutoff are dropped from RAM; disk keeps everything.
func TestEvictIdleByAge(t *testing.T) {
	d := testDaemon(t)
	a := evictTestSession(d, "old", 3)
	evictTestSession(d, "fresh", 1)
	a.mu.Lock()
	a.lastUsedUnixMilli = time.Now().Add(-2 * time.Hour).UnixMilli()
	a.mu.Unlock()

	if n := d.evictIdleSessions(time.Now()); n != 1 {
		t.Fatalf("evicted = %d; want 1", n)
	}
	if _, ok := d.sessions["old"]; ok {
		t.Fatal("old session survived eviction")
	}
	if _, ok := d.sessions["fresh"]; !ok {
		t.Fatal("fresh session was evicted")
	}
	// Reload is lossless: transcript comes back from disk.
	act, err := d.getOrCreateActiveSession("old")
	if err != nil {
		t.Fatal(err)
	}
	if len(act.record.Messages) != 3 || act.record.Title != "old" {
		t.Fatalf("reload lost state: %+v", act.record)
	}
}

// Running turns (and any live flow state) are never eligible.
func TestEvictNeverTouchesLive(t *testing.T) {
	d := testDaemon(t)
	old := time.Now().Add(-2 * time.Hour).UnixMilli()
	mk := func(id string, fn func(act *ActiveSession)) {
		act := evictTestSession(d, id, 1)
		act.mu.Lock()
		fn(act)
		act.lastUsedUnixMilli = old
		act.mu.Unlock()
	}
	mk("running-status", func(act *ActiveSession) { act.record.Status = "running" })
	mk("wal-open", func(act *ActiveSession) {
		ww, err := d.openWAL(act.record.ID, &walHeader{TurnIndex: 1})
		if err != nil {
			t.Fatal(err)
		}
		act.wal = ww
	})
	mk("agent-live", func(act *ActiveSession) { act.cancel = func() {} })
	mk("question-pending", func(act *ActiveSession) { act.question = &pendingQuestion{} })
	mk("approval-pending", func(act *ActiveSession) { act.pendingApproval = &toolApproval{} })
	mk("tool-progress", func(act *ActiveSession) { act.toolProgress = map[string]string{"x": "y"} })

	if n := d.evictIdleSessions(time.Now()); n != 0 {
		t.Fatalf("evicted %d live sessions", n)
	}
	for _, id := range []string{"running-status", "wal-open", "agent-live", "question-pending", "approval-pending", "tool-progress"} {
		if _, ok := d.sessions[id]; !ok {
			t.Fatalf("%s was evicted while live", id)
		}
	}
	d.sessions["wal-open"].wal.close()
}

// Over the resident cap, oldest-first goes even when young.
func TestEvictOverCapOldestFirst(t *testing.T) {
	d := testDaemon(t)
	base := time.Now()
	for i := 0; i < maxResidentSessions+5; i++ {
		act := evictTestSession(d, string(rune('a'+i%26))+string(rune('0'+i/26)), 0)
		act.mu.Lock()
		// All young (no age eviction); staggered LRU clock.
		act.lastUsedUnixMilli = base.Add(-time.Duration(i) * time.Second).UnixMilli()
		act.mu.Unlock()
	}
	if n := d.evictIdleSessions(base); n != 5 {
		t.Fatalf("evicted = %d; want 5", n)
	}
	if len(d.sessions) != maxResidentSessions {
		t.Fatalf("resident = %d; want %d", len(d.sessions), maxResidentSessions)
	}
}

// A turn starting between scan and delete must not be evicted (re-check).
func TestEvictRechecksBeforeDelete(t *testing.T) {
	d := testDaemon(t)
	act := evictTestSession(d, "race", 1)
	act.mu.Lock()
	act.lastUsedUnixMilli = time.Now().Add(-2 * time.Hour).UnixMilli()
	act.mu.Unlock()
	// Simulate: eligible at scan, running at delete. The re-check under
	// both locks must save it. (Direct unit check of the guard.)
	act.mu.Lock()
	if !evictEligible(act) {
		t.Fatal("fresh idle session not eligible")
	}
	act.record.Status = "running"
	if evictEligible(act) {
		t.Fatal("running session reported eligible")
	}
	act.mu.Unlock()
	if n := d.evictIdleSessions(time.Now()); n != 0 {
		t.Fatalf("evicted a running session: %d", n)
	}
}

// getOrCreate refreshes the LRU clock (touch on hit).
func TestGetOrCreateTouchesLRU(t *testing.T) {
	d := testDaemon(t)
	act := evictTestSession(d, "touch", 0)
	act.mu.Lock()
	act.lastUsedUnixMilli = time.Now().Add(-2 * time.Hour).UnixMilli()
	act.mu.Unlock()
	if _, err := d.getOrCreateActiveSession("touch"); err != nil {
		t.Fatal(err)
	}
	if n := d.evictIdleSessions(time.Now()); n != 0 {
		t.Fatal("touched session was evicted by age")
	}
}
