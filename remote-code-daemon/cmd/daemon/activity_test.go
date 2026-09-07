package main

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/patriceckhart/zot/packages/provider"
)

func waitApproval(t *testing.T, act *ActiveSession, id string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		act.mu.Lock()
		ready := act.pendingApproval != nil && act.pendingApproval.CallID == id
		act.mu.Unlock()
		if ready {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("tool did not request approval")
}

func TestPermissionsChangeWithinTurnIncludingWaitingRead(t *testing.T) {
	d := testDaemon(t)
	d.configPath = filepath.Join(d.dataDir, "config.json")
	act := &ActiveSession{record: &SessionRecord{ID: "live-access", Status: "running", Options: SessionOptions{Access: "full"}}, gen: 1}
	d.sessions[act.record.ID] = act
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	hook := d.toolApprovalHook(ctx, act, 1, d.config.HostID)
	if allowed, _, _ := hook(provider.ToolCallBlock{ID: "full", Name: "bash"}); !allowed {
		t.Fatal("Full access prompted")
	}
	d.handleMessage([]byte(`{"type":"configure_session","sessionId":"live-access","options":{"access":"ask"}}`))
	result := make(chan bool, 1)
	go func() {
		allowed, _, _ := hook(provider.ToolCallBlock{ID: "read", Name: "read", Arguments: json.RawMessage(`{"path":"file"}`)})
		result <- allowed
	}()
	waitApproval(t, act, "read")
	d.handleMessage([]byte(`{"type":"tool_approval_response","sessionId":"live-access","callId":"read","approved":true}`))
	if !<-result || act.record.Options.Access != "ask" {
		t.Fatal("Allow once changed the access mode")
	}
	go func() { allowed, _, _ := hook(provider.ToolCallBlock{ID: "todo", Name: "todo"}); result <- allowed }()
	waitApproval(t, act, "todo")
	d.handleMessage([]byte(`{"type":"configure_session","sessionId":"live-access","options":{"access":"full"}}`))
	if !<-result {
		t.Fatal("switching to Full access did not release the pending tool")
	}
	if allowed, _, _ := hook(provider.ToolCallBlock{ID: "next", Name: "write"}); !allowed {
		t.Fatal("next tool ignored the new access mode")
	}
	d.handleMessage([]byte(`{"type":"configure_session","sessionId":"live-access","options":{"access":"ask"}}`))
	go func() { allowed, _, _ := hook(provider.ToolCallBlock{ID: "cancel", Name: "glob"}); result <- allowed }()
	waitApproval(t, act, "cancel")
	cancel()
	if <-result {
		t.Fatal("cancelled approval executed")
	}
	act.mu.Lock()
	defer act.mu.Unlock()
	if len(act.approvalReqs) != 0 || act.pendingApproval != nil {
		t.Fatal("cancel left a pending approval")
	}
}

func TestAlwaysAllowPersistsFullAccess(t *testing.T) {
	d := testDaemon(t)
	act := &ActiveSession{record: &SessionRecord{ID: "always", Status: "running", Options: SessionOptions{Access: "ask"}}, gen: 1}
	d.sessions[act.record.ID] = act
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	hook := d.toolApprovalHook(ctx, act, 1, d.config.HostID)
	result := make(chan bool, 1)
	go func() { allowed, _, _ := hook(provider.ToolCallBlock{ID: "one", Name: "read"}); result <- allowed }()
	waitApproval(t, act, "one")
	d.handleMessage([]byte(`{"type":"tool_approval_response","sessionId":"always","callId":"one","approved":true,"always":true}`))
	if !<-result {
		t.Fatal("Always allow did not approve the pending call")
	}
	rec, err := d.loadSession("always")
	if err != nil || rec.Options.Access != "full" {
		t.Fatal("Always allow did not persist Full access")
	}
	if allowed, _, _ := hook(provider.ToolCallBlock{ID: "two", Name: "bash"}); !allowed {
		t.Fatal("Always allow still prompted on the next tool")
	}
}
