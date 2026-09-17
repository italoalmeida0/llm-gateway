package main

import (
	"context"
	"os"
	"strings"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

// estimateContext counts the live request payload (system + tools +
// projected messages) with btdby4 — the daemon's single ruler for
// context occupancy. Provider-reported usage is metrics only and never
// feeds this number. Estimated stays false: the count is trusted, not
// an approximation.
func estimateContext(agent *core.Agent, model provider.Model) *SessionContext {
	system, tools, messages := agent.ContextSnapshot()
	return &SessionContext{
		UsedTokens:   provider.ContextTokens(system, tools, messages),
		WindowTokens: model.ContextWindow, Model: model.ID, Estimated: false,
	}
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
	// Manual compaction runs as a WAL turn too: freeze + header-only WAL
	// (no user prompt), deltas append, single commit at the end.
	ww, werr := d.openWAL(sid, &walHeader{TurnIndex: act.record.TurnSeq + 1, StartedAt: time.Now().UnixMilli(), Model: model})
	if werr != nil {
		act.record.Status = "idle"
		act.cancel = nil
		act.mu.Unlock()
		_ = d.sendWS(map[string]any{"type": "error", "hostId": cfg.HostID, "sessionId": sid, "message": "Could not compact: " + werr.Error()})
		return
	}
	act.wal = ww
	if serr := d.saveSessionSync(act.record); serr != nil {
		d.discardWAL(act)
		_ = os.Remove(d.walPath(sid))
		act.wal = nil
		act.record.Status = "idle"
		act.cancel = nil
		act.mu.Unlock()
		_ = d.sendWS(map[string]any{"type": "error", "hostId": cfg.HostID, "sessionId": sid, "message": "Could not compact: " + serr.Error()})
		return
	}
	d.notifyChange("sessions")
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
		if act.wal != nil {
			// Compaction aborted (error above): no turn happened, so no
			// turn line is appended — rewrite meta (status flip) + drop
			// the WAL. The frozen lines are untouched.
			d.discardWAL(act)
			_ = os.Remove(d.walPath(sid))
			act.wal = nil
			_ = d.rewriteMetaOnly(sid, recordMeta(act.record))
		} else {
			_ = d.saveSession(act.record)
		}
		d.notifyChange("sessions")
		_ = d.sendWS(map[string]any{"type": "session_data", "hostId": cfg.HostID, "session": pagedHistoryBlock(sessionPayload(act.record), act.record)})
		_ = d.sendWS(map[string]any{"type": "session_status", "hostId": cfg.HostID, "sessionId": sid, "status": "idle"})
	}()
	info := gatewayModel(ctx, cfg.GatewayURL, cfg.DaemonToken, model)
	client := provider.NewGatewayAnthropic(cfg.APIKey, strings.TrimRight(cfg.GatewayURL, "/")+"/anthropic/v1", info)
	agent := core.NewAgent(client, model, "", core.NewRegistry())
	agent.MaxTokens = maxOutputTokens(info)
	agent.SetMessages(messages)
	// Seed the incremental chain so manual /compact keeps updating the
	// previous summary instead of re-summarizing from scratch.
	// Explicit keep-tail: manual compaction always honors the request,
	// even on short transcripts, preserving ~70% as the recent tail.
	agent.SeedCost(act.record.Usage)
	agent.SeedCompactionState(act.record.Compaction)
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
	// History is append-only: manual compaction advances only the chain
	// head. Sync from History (projected Messages() would be
	// the compacted view; persisting it would lose the log).
	act.record.Messages = append([]provider.Message(nil), agent.History()...)
	act.record.Compaction = agent.CompactionChain()
	act.record.Usage = agent.Cost()
	act.record.Context = estimateContext(agent, info)
	act.record.UpdatedAt = time.Now().UnixMilli()
	// Compaction replaces history wholesale (reorders/regroups turns):
	// turn-granular append can't express it — full rewrite via split
	// (rare manual op; correctness over IO savings). Crash between WAL
	// events and rewrite replays the same snapshot idempotently.
	for _, m := range act.record.Messages {
		mc := m
		d.appendWALEvent(act, walMsgEvent(mc))
	}
	usageCopy := act.record.Usage
	ctxCopy := act.record.Context
	stateCopy := *act.record.Compaction
	d.appendWALEvent(act, walEvent{Type: walTypeCompaction, Compaction: &stateCopy, Usage: &usageCopy, Context: ctxCopy})
	d.discardWAL(act)
	_ = os.Remove(d.walPath(sid))
	act.wal = nil
	_ = d.saveSessionSync(act.record)
	d.notifyChange("sessions")
	_ = d.sendWS(map[string]any{
		"type":       "session_compacted",
		"hostId":     cfg.HostID,
		"sessionId":  sid,
		"messages":   sanitizeMessagesForFrontend(act.record.Messages, act.record.Attachments),
		"context":    act.record.Context,
		"compaction": act.record.Compaction,
		"usage":      act.record.Usage,
	})
}
