package main

import (
	"fmt"
	"time"
)

// Idle session eviction: the in-memory session map grows without bound
// otherwise (every touched session stays resident until purge or process
// death — a daemon running for months with thousands of sessions would
// hold gigabytes of transcripts in RAM).
//
// Safety rule: eviction is a pure RAM drop, never a disk write. An idle
// session with no WAL has its full truth in <id>.json, so deleting the
// map entry is lossless — the next touch reloads from disk via
// getOrCreateActiveSession. Anything that is NOT purely reloadable is
// never eligible:
//   - running turn (Status, wal handle, agent, tracker, cancel func)
//   - pending question / file-convert / tool approval flows
//   - in-flight tool progress / live assistant stream state
//
// Two triggers, both best-effort and lock-careful:
//   - age: idle longer than idleEvictAfter (sweeper tick)
//   - count: more resident sessions than maxResidentSessions (sweep evicts
//     oldest-first until back under the cap)

const (
	idleEvictAfter      = 30 * time.Minute
	evictSweepInterval  = 5 * time.Minute
	maxResidentSessions = 200
)

// touchSession marks a session as recently used. Callers hold act.mu or
// own the session exclusively (creation); the timestamp is advisory, so
// no lock ordering with sessionsMu is needed beyond the caller's.
func touchSession(act *ActiveSession) {
	if act == nil {
		return
	}
	act.lastUsedUnixMilli = time.Now().UnixMilli()
}

// evictEligible reports whether act may be dropped from RAM. Call with
// act.mu held.
func evictEligible(act *ActiveSession) bool {
	if act == nil || act.record == nil {
		return false
	}
	if act.record.Status == "running" {
		return false
	}
	if act.wal != nil || act.agent != nil || act.fileChanges != nil {
		return false
	}
	if act.cancel != nil {
		return false
	}
	if act.question != nil || act.convert != nil || act.pendingApproval != nil {
		return false
	}
	if len(act.approvalReqs) != 0 {
		return false
	}
	if act.live != nil || len(act.toolProgress) != 0 || len(act.toolStarts) != 0 {
		return false
	}
	return true
}

// evictIdleSessions drops eligible sessions: all idle past the age cutoff,
// plus oldest-first until back under the resident cap. Returns the count
// evicted. Never touches disk: idle sessions are fully described by
// their JSON on disk (no WAL exists exactly when nothing is in flight).
func (d *DaemonServer) evictIdleSessions(now time.Time) int {
	cutoff := now.Add(-idleEvictAfter).UnixMilli()
	type candidate struct {
		id       string
		lastUsed int64
	}
	d.sessionsMu.RLock()
	var aged []candidate
	var all []candidate
	for id, act := range d.sessions {
		if act == nil {
			continue
		}
		act.mu.Lock()
		eligible := evictEligible(act)
		lastUsed := act.lastUsedUnixMilli
		act.mu.Unlock()
		if !eligible {
			continue
		}
		c := candidate{id: id, lastUsed: lastUsed}
		all = append(all, c)
		if lastUsed <= cutoff {
			aged = append(aged, c)
		}
	}
	d.sessionsMu.RUnlock()

	// Oldest-first for the count cap: sort by lastUsed ascending.
	// Simple insertion sort is fine — sweeps are rare and N is small.
	byAge := append([]candidate{}, all...)
	for i := 1; i < len(byAge); i++ {
		for j := i; j > 0 && byAge[j].lastUsed < byAge[j-1].lastUsed; j-- {
			byAge[j], byAge[j-1] = byAge[j-1], byAge[j]
		}
	}
	overCap := len(all) - maxResidentSessions
	targets := map[string]bool{}
	for _, c := range aged {
		targets[c.id] = true
	}
	for i := 0; i < len(byAge) && overCap > 0; i++ {
		if !targets[byAge[i].id] {
			targets[byAge[i].id] = true
			overCap--
		}
	}
	if len(targets) == 0 {
		return 0
	}

	evicted := 0
	d.sessionsMu.Lock()
	defer d.sessionsMu.Unlock()
	for id := range targets {
		act := d.sessions[id]
		if act == nil {
			continue
		}
		// Re-check under both locks: a turn may have started between the
		// scan and now. Never evict something that became live.
		act.mu.Lock()
		eligible := evictEligible(act)
		act.mu.Unlock()
		if !eligible {
			continue
		}
		delete(d.sessions, id)
		evicted++
	}
	if evicted > 0 {
		fmt.Printf("[EVICT] dropped %d idle sessions from RAM (%d resident)\n", evicted, len(d.sessions))
	}
	return evicted
}

// startEvictionSweeper launches the background sweep loop. Stop it with
// stopEvictionSweeper (shutdown path) — in tests the sweeper never starts
// and eviction is driven directly via evictIdleSessions.
func (d *DaemonServer) startEvictionSweeper() {
	d.evictMu.Lock()
	defer d.evictMu.Unlock()
	if d.evictStop != nil {
		return
	}
	stop := make(chan struct{})
	d.evictStop = stop
	go func() {
		ticker := time.NewTicker(evictSweepInterval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case now := <-ticker.C:
				d.evictIdleSessions(now)
			}
		}
	}()
}

func (d *DaemonServer) stopEvictionSweeper() {
	d.evictMu.Lock()
	stop := d.evictStop
	d.evictStop = nil
	d.evictMu.Unlock()
	if stop == nil {
		return
	}
	close(stop)
}
