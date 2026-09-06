package main

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/patriceckhart/zot/packages/core"
	"github.com/patriceckhart/zot/packages/provider"
)

func estimateContext(agent *core.Agent, model provider.Model) *SessionContext {
	system, tools, messages := agent.ContextSnapshot()
	data, _ := json.Marshal(struct {
		System   string
		Tools    []provider.Tool
		Messages []provider.Message
	}{system, tools, messages})
	return &SessionContext{UsedTokens: (len(data) + 3) / 4, WindowTokens: model.ContextWindow, Model: model.ID, Estimated: true}
}

// Manual compaction uses the same summarizer as automatic compaction. Preserve
// recent messages and only replace history after the summary succeeds.
func (d *DaemonServer) compactSession(act *ActiveSession) {
	d.configMu.RLock()
	cfg := *d.config
	d.configMu.RUnlock()
	d.sessionsMu.RLock()
	act.mu.Lock()
	if d.sessions[act.record.ID] != act || act.record.Status == "running" {
		act.mu.Unlock()
		d.sessionsMu.RUnlock()
		return
	}
	d.sessionsMu.RUnlock()
	sid, model := act.record.ID, act.record.Model
	if len(act.record.Messages) < 4 {
		act.mu.Unlock()
		_ = d.sendWS(map[string]any{"type": "notice", "hostId": cfg.HostID, "sessionId": sid, "message": "The conversation is already short enough."})
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	act.gen++
	gen := act.gen
	act.cancel = cancel
	act.record.Status = "running"
	messages := append([]provider.Message(nil), act.record.Messages...)
	_ = d.saveSession(act.record)
	act.mu.Unlock()
	_ = d.sendWS(map[string]any{"type": "session_status", "hostId": cfg.HostID, "sessionId": sid, "status": "running"})
	defer func() {
		act.mu.Lock()
		defer act.mu.Unlock()
		if act.gen != gen {
			return
		}
		act.record.Status = "idle"
		act.cancel = nil
		_ = d.saveSession(act.record)
		_ = d.sendWS(map[string]any{"type": "session_data", "hostId": cfg.HostID, "session": sessionPayload(act.record)})
		_ = d.sendWS(map[string]any{"type": "session_status", "hostId": cfg.HostID, "sessionId": sid, "status": "idle"})
	}()
	info := gatewayModel(ctx, cfg.GatewayURL, cfg.DaemonToken, model)
	client := provider.NewGatewayOpenAI(cfg.APIKey, strings.TrimRight(cfg.GatewayURL, "/")+"/v1", info)
	agent := core.NewAgent(client, model, "", core.NewRegistry())
	agent.SetMessages(messages)
	_, err := agent.Compact(ctx, max(2, len(messages)*7/10), nil)
	if err != nil {
		if ctx.Err() == nil {
			_ = d.sendWS(map[string]any{"type": "error", "hostId": cfg.HostID, "sessionId": sid, "message": "Could not compact the conversation: " + err.Error()})
		}
		return
	}
	act.mu.Lock()
	defer act.mu.Unlock()
	if act.gen != gen {
		return
	}
	act.record.Messages = append([]provider.Message(nil), agent.Messages()...)
	act.record.Context = estimateContext(agent, info)
	act.record.UpdatedAt = time.Now().UnixMilli()
	_ = d.saveSession(act.record)
	_ = d.sendWS(map[string]any{"type": "session_compacted", "hostId": cfg.HostID, "sessionId": sid, "messages": act.record.Messages, "context": act.record.Context})
}
