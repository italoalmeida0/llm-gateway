package main

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/provider"
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
		if reason := modeToolRestriction(act.record.Options.Mode, call.Name); reason != "" {
			act.mu.Unlock()
			return false, reason, nil
		}
		// The questionnaire and signal tools do not need manual user approval.
		if act.record.Options.Access == "full" || call.Name == "question" || call.Name == "todo" || call.Name == "mark_task_as_complete" || call.Name == "mark_plan_as_ready_to_execute" {
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
			act.mu.Lock()
			reason := modeToolRestriction(act.record.Options.Mode, call.Name)
			stale := act.gen != gen
			act.mu.Unlock()
			if stale {
				return false, "Turn cancelled", nil
			}
			if reason != "" {
				return false, reason, nil
			}
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
	// Stamp the wall-clock duration on every message of this turn so
	// finished aggregates can show "<time>" next to the toggle chevron
	// (the live footer only covers the current turn).
	if dur := act.record.Turn.EndedAt - act.record.Turn.StartedAt; dur > 0 {
		stamp := strconv.FormatInt(dur, 10)
		for i := range act.record.Messages {
			m := &act.record.Messages[i]
			if m.TurnIndex != act.record.TurnSeq {
				continue
			}
			if m.Meta == nil {
				m.Meta = map[string]string{}
			}
			m.Meta["turn_ms"] = stamp
		}
	}
}

func modeToolRestriction(mode, tool string) string {
	mode = normalizedOptions(SessionOptions{Mode: mode}).Mode
	if strings.HasPrefix(tool, "mcp__") && mode != "build" {
		return "MCP tools are only available in Build mode."
	}
	if mode == "talk" {
		for _, name := range []string{"read", "write", "edit", "search", "inspect", "bash", "python", "glob", "mark_task_as_complete", "mark_plan_as_ready_to_execute", "patch"} {
			if tool == name {
				return "The session is in talk mode. Workspace tools are disabled."
			}
		}
	}
	if (mode == "plan" || mode == "learning") && (tool == "write" || tool == "edit" || tool == "patch") {
		return "The session is now in " + mode + " mode. Edit and create tools are disabled."
	}
	if mode != "plan" && tool == "mark_plan_as_ready_to_execute" {
		return "mark_plan_as_ready_to_execute is only available in plan mode."
	}
	if mode != "build" && tool == "mark_task_as_complete" {
		return "mark_task_as_complete is only available in build mode."
	}
	return ""
}
