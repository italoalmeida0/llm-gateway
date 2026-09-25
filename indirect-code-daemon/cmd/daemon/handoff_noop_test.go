package main

import (
	"testing"
	"time"
)

// Same-version guard: a stale manifest (or double click) must never
// freeze, disconnect or kill a healthy daemon — abort with a message.
func TestHandoffSameVersionNoop(t *testing.T) {
	d := testDaemon(t)
	st := d.updateChecker()
	st.mu.Lock()
	st.available = daemonVersion // manifest agrees with running (or dev/dev)
	st.mu.Unlock()
	d.beginHandoff()
	// beginHandoff is async (go runHandoff); give it a beat, then assert
	// nothing spawned (busy cleared, reason recorded).
	time.Sleep(200 * time.Millisecond)
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.handoffBusy {
		t.Fatal("same-version handoff marked busy")
	}
}
