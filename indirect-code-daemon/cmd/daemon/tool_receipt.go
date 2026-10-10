package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"llm-gateway/indirect-code-daemon/internal/durable"
	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
	"llm-gateway/indirect-code-daemon/packages/runner"
)

type executionReceipt struct {
	Version     int             `json:"v"`
	ID          string          `json:"id"`
	Fingerprint string          `json:"fingerprint"`
	Phase       string          `json:"phase"`
	Recovered   bool            `json:"recovered,omitempty"`
	Result      json.RawMessage `json:"result,omitempty"`
}

// executionHash derives a compact identity token: 8 bytes of SHA-256,
// 16 hex chars. Full 64-hex hashes made job ids unreadable in prompts and
// logs; 64 bits is ample for per-session call identities (collision odds
// ~2^-64 per call pair).
func executionHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:8])
}

// validExecutionHex accepts current 16-hex and legacy 64-hex identity
// halves so receipts written before the id shortening still resolve.
func validExecutionHex(part string) bool {
	return len(part) == 16 || len(part) == 64
}

// Scope and invocation are hashes, never untrusted path components. Receipts
// stay outside the brain so ordinary log reads cannot modify execution claims.
func executionReceiptPath(root, sid, id string) string {
	parts := strings.Split(id, "_")
	if !validSessionID(sid) || len(parts) != 2 || !validExecutionHex(parts[0]) || !validExecutionHex(parts[1]) {
		return ""
	}
	for _, part := range parts {
		if _, err := hex.DecodeString(part); err != nil {
			return ""
		}
	}
	return filepath.Join(root, "executions", sid, parts[0], id+".json")
}

type recordedTool struct {
	core.Tool
	root, sid, scope, cwd string
}

func (t *recordedTool) Execute(ctx context.Context, args json.RawMessage, progress func(string)) (core.ToolResult, error) {
	callID := core.ToolCallID(ctx)
	if callID == "" {
		return core.ToolResult{}, fmt.Errorf("missing tool invocation identity")
	}
	var canonical any
	decoder := json.NewDecoder(bytes.NewReader(args))
	decoder.UseNumber()
	if err := decoder.Decode(&canonical); err != nil {
		return core.ToolResult{}, err
	}
	normalized, _ := json.Marshal(canonical)
	fingerprint := executionHash(t.Name() + "\x00" + t.cwd + "\x00" + string(normalized))
	id := t.scope + "_" + executionHash(callID)
	path := executionReceiptPath(t.root, t.sid, id)
	if path == "" {
		return core.ToolResult{}, fmt.Errorf("invalid execution identity")
	}
	if raw, err := os.ReadFile(path); err == nil {
		var rec executionReceipt
		if json.Unmarshal(raw, &rec) != nil || rec.ID != id || rec.Fingerprint != fingerprint {
			return core.ToolResult{}, fmt.Errorf("execution identity conflicts with its saved operation")
		}
		return t.resolve(&rec, path)
	} else if !os.IsNotExist(err) {
		return core.ToolResult{}, err
	}
	// A model can give a retry a new call ID. An unresolved effect blocks
	// further mutations in this logical turn until evidence resolves it.
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil && !os.IsNotExist(err) {
		return core.ToolResult{}, err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(filepath.Dir(path), entry.Name()))
		var rec executionReceipt
		if err != nil || json.Unmarshal(raw, &rec) != nil {
			return core.ToolResult{}, unknownExecution(entry.Name())
		}
		if rec.Phase != "completed" {
			result, err := t.resolve(&rec, filepath.Join(filepath.Dir(path), entry.Name()))
			if err != nil {
				return core.ToolResult{}, err
			}
			if rec.Fingerprint == fingerprint {
				return result, nil
			}
		} else if rec.Recovered && rec.Fingerprint == fingerprint {
			return receiptResult(&rec)
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return core.ToolResult{}, err
	}
	rec := executionReceipt{Version: 1, ID: id, Fingerprint: fingerprint, Phase: "prepared"}
	raw, _ := json.Marshal(rec)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return core.ToolResult{}, fmt.Errorf("execution already claimed or storage unavailable: %w", err)
	}
	_, err = f.Write(raw)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = durable.SyncDir(filepath.Dir(path))
	}
	if err != nil {
		return core.ToolResult{}, err
	} // retain uncertain claim
	result, runErr := t.Tool.Execute(core.WithExecutionID(ctx, id), args, progress)
	if t.Name() == "bash" || t.Name() == "python" {
		// A wrapper exit (including persistence failure) is not proof that
		// the user's command failed before producing an external effect.
		if _, claimErr := os.Stat(filepath.Join(runner.RunnersDir(t.root), id+".launch")); claimErr == nil {
			st, stateErr := runner.ReadState(runner.StatePath(t.root, id))
			det, _ := result.Details.(map[string]any)
			detached := runErr == nil && !result.IsError && det["background_job_id"] == id
			if stateErr != nil || st.OutcomeUnknown || (!st.Terminal() && !detached) || (st.Terminal() && !st.OutputReady) {
				return core.ToolResult{}, unknownExecution(id)
			}
		}
	}
	if runErr != nil {
		result = core.ToolResult{IsError: true, Content: []provider.Content{provider.TextBlock{Text: runErr.Error()}}}
	}
	if err := completeReceipt(path, &rec, result); err != nil {
		return core.ToolResult{}, unknownExecution(id)
	}
	return result, nil
}

func unknownExecution(id string) error {
	return fmt.Errorf("execution %s has an unknown outcome; it may already have changed files or external state. Read its logs and verify effects. Automatic mutations in this turn are paused; start a new user turn only after deciding whether to retry", id)
}

func completeReceipt(path string, rec *executionReceipt, result core.ToolResult) error {
	msg := provider.Message{Role: provider.RoleTool, Content: []provider.Content{provider.ToolResultBlock{CallID: rec.ID, Content: result.Content, IsError: result.IsError, Details: result.Details}}}
	raw, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	rec.Result, rec.Phase = raw, "completed"
	raw, err = json.Marshal(rec)
	if err != nil {
		return err
	}
	return durable.Write(path, raw)
}

func receiptResult(rec *executionReceipt) (core.ToolResult, error) {
	msg, err := core.HydrateMessageObject(rec.Result)
	if err != nil || len(msg.Content) != 1 {
		return core.ToolResult{}, unknownExecution(rec.ID)
	}
	r, ok := msg.Content[0].(provider.ToolResultBlock)
	if !ok {
		return core.ToolResult{}, unknownExecution(rec.ID)
	}
	return core.ToolResult{Content: r.Content, IsError: r.IsError, Details: r.Details}, nil
}

func (t *recordedTool) resolve(rec *executionReceipt, path string) (core.ToolResult, error) {
	if rec.Phase == "completed" {
		return receiptResult(rec)
	}
	st, err := runner.ReadState(runner.StatePath(t.root, rec.ID))
	if err != nil || st.SessionID != t.sid || st.JobID != rec.ID || st.OutcomeUnknown {
		return core.ToolResult{}, unknownExecution(rec.ID)
	}
	if !st.Terminal() {
		return core.ToolResult{}, fmt.Errorf("execution %s is already running or awaiting recovery; do not launch a replacement. Inspect the background task and its log: %s", rec.ID, st.BrainPath)
	}
	if err := repairTerminalCopy(st); err != nil {
		return core.ToolResult{}, unknownExecution(rec.ID)
	}
	code := -1
	if st.ExitCode != nil {
		code = *st.ExitCode
	}
	result := core.ToolResult{IsError: code != 0, Content: []provider.Content{provider.TextBlock{Text: fmt.Sprintf("Recovered execution %s (exit %d). Read full output: %s", rec.ID, code, st.BrainPath)}}}
	rec.Recovered = true
	if err := completeReceipt(path, rec, result); err != nil {
		return core.ToolResult{}, unknownExecution(rec.ID)
	}
	return result, nil
}
