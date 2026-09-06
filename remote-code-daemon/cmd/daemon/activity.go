package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/patriceckhart/zot/packages/provider"
)

type TurnActivity struct {
	StartedAt int64  `json:"startedAt"`
	EndedAt   int64  `json:"endedAt,omitempty"`
	Status    string `json:"status"`
}

type toolApproval struct {
	gen    int
	CallID string          `json:"callId"`
	Tool   string          `json:"tool"`
	Args   json.RawMessage `json:"args"`
}

// act.mu is held. Full access also releases a call already awaiting approval.
func (d *DaemonServer) allowPendingTools(act *ActiveSession) {
	for id, ch := range act.approvalReqs {
		select {
		case ch <- true:
		default:
		}
		delete(act.approvalReqs, id)
	}
	act.pendingApproval = nil
}

func (d *DaemonServer) toolApprovalHook(ctx context.Context, act *ActiveSession, gen int, hostID string) func(provider.ToolCallBlock) (bool, string, json.RawMessage) {
	return func(call provider.ToolCallBlock) (bool, string, json.RawMessage) {
		act.mu.Lock()
		if act.gen != gen || ctx.Err() != nil {
			act.mu.Unlock()
			return false, "Turn cancelled", nil
		}
		if act.record.Options.Access == "full" {
			act.mu.Unlock()
			return true, "", nil
		}
		if act.approvalReqs == nil {
			act.approvalReqs = map[string]chan bool{}
		}
		ch := make(chan bool, 1)
		act.approvalReqs[call.ID] = ch
		act.pendingApproval = &toolApproval{gen: gen, CallID: call.ID, Tool: call.Name, Args: call.Arguments}
		_ = d.sendWS(map[string]any{"type": "tool_approval_request", "hostId": hostID, "sessionId": act.record.ID, "callId": call.ID, "tool": call.Name, "args": call.Arguments})
		act.mu.Unlock()
		defer func() {
			act.mu.Lock()
			defer act.mu.Unlock()
			if act.approvalReqs[call.ID] == ch {
				delete(act.approvalReqs, call.ID)
			}
			if act.pendingApproval != nil && act.pendingApproval.gen == gen && act.pendingApproval.CallID == call.ID {
				act.pendingApproval = nil
			}
		}()
		select {
		case approved := <-ch:
			if ctx.Err() != nil {
				return false, "Turn cancelled", nil
			}
			if !approved {
				return false, "User rejected tool execution", nil
			}
			return true, "", nil
		case <-ctx.Done():
			return false, "Turn cancelled", nil
		}
	}
}

func finishTurnActivity(act *ActiveSession, cancelled bool) {
	if act.record.Turn == nil {
		return
	}
	act.record.Turn.EndedAt = time.Now().UnixMilli()
	if cancelled {
		act.record.Turn.Status = "cancelled"
	} else if act.record.Turn.Status == "running" {
		act.record.Turn.Status = "completed"
	}
}
