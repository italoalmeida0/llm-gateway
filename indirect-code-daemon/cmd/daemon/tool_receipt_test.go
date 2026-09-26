package main

import (
	"context"
	"encoding/json"
	"llm-gateway/indirect-code-daemon/internal/durable"
	"llm-gateway/indirect-code-daemon/packages/runner"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

type receiptTestTool struct{ run func() }

func (*receiptTestTool) Name() string            { return "write" }
func (*receiptTestTool) Description() string     { return "test effect" }
func (*receiptTestTool) Schema() json.RawMessage { return json.RawMessage(`{}`) }
func (t *receiptTestTool) Execute(context.Context, json.RawMessage, func(string)) (core.ToolResult, error) {
	t.run()
	return core.ToolResult{Content: []provider.Content{provider.TextBlock{Text: "saved"}}}, nil
}

func TestCrashContractReceiptDeduplicatesIntent(t *testing.T) {
	count := 0
	r := &recordedTool{Tool: &receiptTestTool{func() { count++ }}, root: t.TempDir(), sid: "s1", scope: executionHash("turn1")}
	ctx := core.WithToolCallID(context.Background(), "call-1")
	for range 2 {
		res, err := r.Execute(ctx, json.RawMessage(`{"value":1}`), nil)
		if err != nil || len(res.Content) != 1 {
			t.Fatalf("replay failed: %v", err)
		}
	}
	if count != 1 {
		t.Fatalf("duplicate effect: %d", count)
	}
	if _, err := r.Execute(ctx, json.RawMessage(`{"value":2}`), nil); err == nil {
		t.Fatal("same identity accepted different arguments")
	}
	ctx = core.WithToolCallID(context.Background(), "call-2")
	if _, err := r.Execute(ctx, json.RawMessage(`{"value":1}`), nil); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatal("intentional second invocation was suppressed")
	}
}

func TestCrashContractReceiptKilledHelper(t *testing.T) {
	root := os.Getenv("LLMGW_CONTRACT_RECEIPT_ROOT")
	if root == "" {
		return
	}
	tool := &receiptTestTool{run: func() {
		resp, err := http.Post(os.Getenv("LLMGW_CONTRACT_RECEIPT_URL"), "text/plain", nil)
		if err != nil {
			os.Exit(3)
		}
		_ = resp.Body.Close()
		p, _ := os.FindProcess(os.Getpid())
		_ = p.Kill()
		select {}
	}}
	r := &recordedTool{Tool: tool, root: root, sid: "s1", scope: executionHash("turn1")}
	_, _ = r.Execute(core.WithToolCallID(context.Background(), "call-1"), json.RawMessage(`{}`), nil)
	os.Exit(4)
}

func TestCrashContractLostResultDoesNotRepeatExternalEffect(t *testing.T) {
	root := t.TempDir()
	var effects atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { effects.Add(1); w.WriteHeader(201) }))
	defer srv.Close()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestCrashContractReceiptKilledHelper$")
	cmd.Env = append(os.Environ(), "LLMGW_CONTRACT_RECEIPT_ROOT="+root, "LLMGW_CONTRACT_RECEIPT_URL="+srv.URL)
	if err := cmd.Run(); err == nil {
		t.Fatal("fixture did not crash")
	}
	if effects.Load() != 1 {
		t.Fatalf("fixture effects=%d", effects.Load())
	}
	for range 2 { // independent recovery owners, same on-disk evidence
		r := &recordedTool{Tool: &receiptTestTool{func() { effects.Add(1) }}, root: root, sid: "s1", scope: executionHash("turn1")}
		for _, id := range []string{"call-1", "model-retry-new-id"} {
			if _, err := r.Execute(core.WithToolCallID(context.Background(), id), json.RawMessage(`{}`), nil); err == nil {
				t.Fatal("unknown outcome was retried")
			}
		}
	}
	if effects.Load() != 1 {
		t.Fatal("duplicate remote effect after recovery")
	}
	r := &recordedTool{Tool: &receiptTestTool{func() { effects.Add(1) }}, root: root, sid: "s1", scope: executionHash("explicit-new-turn")}
	if _, err := r.Execute(core.WithToolCallID(context.Background(), "call-1"), json.RawMessage(`{}`), nil); err != nil {
		t.Fatal(err)
	}
	if effects.Load() != 2 {
		t.Fatal("new explicit intent could not execute")
	}
}

func TestCrashContractReceiptRecoversRunnerAndRepairsOutput(t *testing.T) {
	root := t.TempDir()
	scope := executionHash("turn1")
	id := scope + "_" + executionHash("lost-call")
	path := executionReceiptPath(root, "s1", id)
	fingerprint := executionHash("write\x00\x00{}")
	rec := executionReceipt{Version: 1, ID: id, Fingerprint: fingerprint, Phase: "prepared"}
	raw, _ := json.Marshal(rec)
	if err := durable.Write(path, raw); err != nil {
		t.Fatal(err)
	}
	source, output := filepath.Join(root, "source.log"), filepath.Join(root, "brain.log")
	if err := os.WriteFile(source, []byte("complete output"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(output, []byte("torn"), 0o600); err != nil {
		t.Fatal(err)
	}
	code := 0
	if err := runner.WriteState(root, &runner.State{JobID: id, SessionID: "s1", Status: runner.StatusDone, ExitCode: &code, LogPath: source, BrainPath: output}); err != nil {
		t.Fatal(err)
	}
	count := 0
	for range 2 {
		r := &recordedTool{Tool: &receiptTestTool{func() { count++ }}, root: root, sid: "s1", scope: scope}
		for _, callID := range []string{"lost-call", "new-model-id"} {
			res, err := r.Execute(core.WithToolCallID(context.Background(), callID), json.RawMessage(`{}`), nil)
			if err != nil || res.IsError {
				t.Fatalf("recovery failed: %v", err)
			}
		}
	}
	if count != 0 {
		t.Fatal("recovery launched replacement work")
	}
	raw, err := os.ReadFile(output)
	if err != nil || string(raw) != "complete output" {
		t.Fatal("output was not repaired")
	}
}
