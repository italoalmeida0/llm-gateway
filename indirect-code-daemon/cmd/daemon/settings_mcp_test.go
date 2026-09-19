package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/mcp"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestSettingsAtomicValidationConflictAndSecrets(t *testing.T) {
	d := testDaemon(t)
	d.configPath = filepath.Join(d.dataDir, "config.json")
	wire := attachmentWire(t, d)
	original := configRevision(d.config)
	save := map[string]any{"type": "update_config", "requestId": "save", "expectedRevision": original, "mcpServers": map[string]any{"local": map[string]any{"command": "fixture-executable", "args": []string{"path with spaces"}, "env": map[string]string{"TOKEN": "fixture-secret"}}}, "skills": map[string]any{"review": SkillConfig{Name: "review", Body: "Review instructions", Enabled: true}}}
	response := wire(save)
	if response["success"] != true {
		t.Fatalf("save failed: %v", response)
	}
	data, err := os.ReadFile(d.configPath)
	if err != nil {
		t.Fatal(err)
	}
	var saved DaemonConfig
	if json.Unmarshal(data, &saved) != nil || saved.Skills["review"].Body != "Review instructions" || saved.MCPServers["local"].Env["TOKEN"] != "fixture-secret" {
		t.Fatal("config not persisted")
	}
	// Windows ACLs ignore Unix permission bits (Go reports 0666): the
	// real guarantee there is the user-profile dir ACL, not the mode.
	if runtime.GOOS != "windows" {
		if info, _ := os.Stat(d.configPath); info.Mode().Perm() != 0600 {
			t.Fatal("config permissions")
		}
	}
	mirrored, _ := json.Marshal(d.mirroredMCP())
	if strings.Contains(string(mirrored), "fixture-secret") || !strings.Contains(string(mirrored), "TOKEN") {
		t.Fatal("secret values reached mirror or key names disappeared")
	}
	rev := configRevision(d.config)
	d.config.LastSelection = &ModelSelection{Model: "another"}
	if configRevision(d.config) != rev {
		t.Fatal("session choices conflict with editor")
	}
	response = wire(map[string]any{"type": "update_config", "requestId": "conflict", "expectedRevision": original, "skills": map[string]SkillConfig{}})
	if response["success"] != false || len(d.config.Skills) != 1 {
		t.Fatal("stale editor overwrote settings")
	}
	response = wire(map[string]any{"type": "update_config", "requestId": "invalid", "expectedRevision": rev, "settings": map[string]any{"temperature": "invalid"}, "skills": map[string]SkillConfig{}})
	if response["success"] != false || configRevision(d.config) != rev {
		t.Fatal("invalid payload partially mutated config")
	}
	response = wire(map[string]any{"type": "update_config", "requestId": "preserve", "expectedRevision": rev, "mcpServers": map[string]any{"local": map[string]any{"command": "new-executable", "disabled": true}}})
	if response["success"] != true || d.config.MCPServers["local"].Env["TOKEN"] != "fixture-secret" {
		t.Fatal("editing a server erased saved credentials")
	}
	response = wire(map[string]any{"type": "update_config", "requestId": "clear-secret", "mcpServers": map[string]any{"local": map[string]any{"command": "new-executable", "env": map[string]string{}}}})
	if response["success"] != true || len(d.config.MCPServers["local"].Env) != 0 {
		t.Fatal("explicit clear did not clear credentials")
	}
	rev = configRevision(d.config)
	d.configPath = filepath.Join(d.dataDir, "directory")
	os.Mkdir(d.configPath, 0700)
	response = wire(map[string]any{"type": "update_config", "requestId": "disk-error", "skills": map[string]SkillConfig{}})
	if response["success"] != false || configRevision(d.config) != rev {
		t.Fatal("disk failure confirmed success or left mutated memory")
	}
	files, _ := filepath.Glob(filepath.Join(d.dataDir, ".config-*"))
	if len(files) != 0 {
		t.Fatal("temporary secret config left behind")
	}
}
func TestSelectedSkillsAndMCPSecretsNeverEnterPrompt(t *testing.T) {
	cfg := DaemonConfig{Skills: map[string]SkillConfig{"chosen": {Name: "chosen", Body: "Unique selected instructions", Enabled: true}, "disabled": {Name: "disabled", Body: "Do not include disabled", Enabled: false}, "other": {Name: "other", Body: "Do not include unselected", Enabled: true}}, MCPServers: map[string]MCPServerConfig{"remote": {Command: "fixture-secret", Args: []string{"fixture-secret"}}}}
	for _, mode := range []string{"build", "plan", "learning", "talk"} {
		prompt := sessionSystemPrompt(cfg, "/tmp", SessionOptions{Mode: mode, Skills: []string{"chosen", "chosen", "disabled", "missing"}})
		if strings.Count(prompt, "Unique selected instructions") != 1 || strings.Contains(prompt, "Do not include") || strings.Contains(prompt, "fixture-secret") {
			t.Fatalf("wrong skill context in %s", mode)
		}
	}
}
func fixtureMCP(t *testing.T) (*httptest.Server, *atomic.Int32, *atomic.Int32) {
	t.Helper()
	var calls, inits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var msg struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if json.NewDecoder(r.Body).Decode(&msg) != nil {
			w.WriteHeader(400)
			return
		}
		if len(msg.ID) == 0 {
			w.WriteHeader(202)
			return
		}
		var result any
		switch msg.Method {
		case "initialize":
			inits.Add(1)
			result = map[string]any{"protocolVersion": mcp.ProtocolVersion, "capabilities": map[string]any{"tools": map[string]any{}}}
		case "tools/list":
			result = map[string]any{"tools": []any{map[string]any{"name": "inspect/item", "description": "Inspect a remote item", "inputSchema": map[string]any{"type": "object"}}}}
		case "tools/call":
			calls.Add(1)
			result = map[string]any{"content": []any{map[string]any{"type": "text", "text": "Remote item inspected"}}}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": result})
	}))
	return server, &calls, &inits
}
func TestMCPDiscoveryToolPolicyAndConfigChanges(t *testing.T) {
	server, calls, inits := fixtureMCP(t)
	defer server.Close()
	d := testDaemon(t)
	d.config.MCPServers = map[string]MCPServerConfig{"remote": {Transport: "http", URL: server.URL}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	act := &ActiveSession{gen: 1, record: &SessionRecord{ID: "mcp", Options: SessionOptions{Mode: "build", Access: "full"}}}
	run := &turnRun{d: d, cfg: *d.config, act: act, ctx: ctx, myGen: 1, sessionID: "mcp", sessionCWD: t.TempDir()}
	defer run.closeMCP()
	reg := core.Registry{}
	run.syncMCP(ctx, *d.config, act.record.Options, reg)
	name := mcpToolName("remote", "inspect/item")
	tool := reg[name]
	if tool == nil || len(name) > 64 || inits.Load() != 1 {
		t.Fatal("tool discovery failed")
	}
	result, err := tool.Execute(ctx, json.RawMessage(`{}`), nil)
	if err != nil || result.IsError || calls.Load() != 1 {
		t.Fatal("MCP tool did not execute")
	}
	run.syncMCP(ctx, *d.config, act.record.Options, core.Registry{})
	if inits.Load() != 1 {
		t.Fatal("live connection unnecessarily replaced")
	}
	for _, mode := range []string{"plan", "learning", "talk"} {
		act.record.Options.Mode = mode
		if ok, _, _ := d.toolApprovalHook(ctx, act, 1, d.config.HostID)(provider.ToolCallBlock{ID: "call", Name: name}); ok {
			t.Fatal("MCP bypassed mode")
		}
		if _, err = tool.Execute(ctx, json.RawMessage(`{}`), nil); err == nil {
			t.Fatal("stale tool bypassed mode change")
		}
	}
	act.record.Options.Mode = "build"
	d.config.Settings.JailByDefault = true
	if _, err = tool.Execute(ctx, json.RawMessage(`{}`), nil); err == nil {
		t.Fatal("MCP bypassed jail")
	}
	run.syncMCP(ctx, *d.config, act.record.Options, core.Registry{})
	if len(run.mcp) != 0 {
		t.Fatal("jail did not close connection")
	}
	d.config.Settings.JailByDefault = false
	reg = core.Registry{}
	run.syncMCP(ctx, *d.config, act.record.Options, reg)
	tool = reg[name]
	d.config.MCPServers = map[string]MCPServerConfig{}
	if _, err = tool.Execute(ctx, json.RawMessage(`{}`), nil); err == nil || calls.Load() != 1 {
		t.Fatal("removed tool executed")
	}
	if mcpToolName("a-b", "c") == mcpToolName("a", "b-c") {
		t.Fatal("tool naming collision")
	}
}
func TestMCPManualTestDiscoversWithoutCallingTools(t *testing.T) {
	server, calls, inits := fixtureMCP(t)
	defer server.Close()
	d := testDaemon(t)
	wire := attachmentWire(t, d)
	response := wire(map[string]any{"type": "test_mcp", "requestId": "test", "name": "remote", "server": MCPServerConfig{Transport: "http", URL: server.URL}})
	if response["status"] != "tested" || response["toolCount"] != float64(1) || calls.Load() != 0 || inits.Load() != 1 {
		t.Fatalf("manual test: %v", response)
	}
	response = wire(map[string]any{"type": "test_mcp", "requestId": "stale-test", "name": "remote", "expectedRevision": "stale", "server": MCPServerConfig{Transport: "http", URL: server.URL}})
	if response["status"] != "error" || inits.Load() != 1 {
		t.Fatal("stale connection test used current secrets with an old configuration")
	}

}
func TestMCPRealProviderTurnAndResultPersistence(t *testing.T) {
	remote, calls, _ := fixtureMCP(t)
	defer remote.Close()
	var requests atomic.Int32
	toolName := mcpToolName("remote", "inspect/item")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/indirect-code/models" {
			fmt.Fprint(w, `{"models":[{"id":"m","limit":{"context":100000,"output":1000}}]}`)
			return
		}
		var body json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&body)
		if !strings.Contains(string(body), toolName) || !strings.Contains(string(body), "Selected skill instructions") {
			t.Error("provider did not receive MCP tool and selected skill")
		}
		if strings.Contains(string(body), "fixture-secret") {
			t.Error("MCP credentials leaked to model")
		}
		n := requests.Add(1)
		if n == 2 && !strings.Contains(string(body), "Remote item inspected") {
			t.Error("tool result missing in model context")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		emit := func(event string, payload any) {
			b, _ := json.Marshal(payload)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
		}
		emit("message_start", map[string]any{"type": "message_start", "message": map[string]any{"model": "m", "usage": map[string]int{"input_tokens": 1}}})
		name, args := toolName, `{}`
		if n > 1 {
			name, args = "mark_task_as_complete", `{"notes":"Completed"}`
		}
		emit("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": fmt.Sprint(n), "name": name, "input": map[string]any{}}})
		emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": args}})
		emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
		emit("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "tool_use"}, "usage": map[string]int{"output_tokens": 1}})
		emit("message_stop", map[string]any{"type": "message_stop"})
	}))
	defer upstream.Close()
	defer upstream.CloseClientConnections()
	d := testDaemon(t)
	defer d.quiesceSessions()
	d.config.GatewayURL = upstream.URL
	d.config.MCPServers = map[string]MCPServerConfig{"remote": {Transport: "http", URL: remote.URL, Headers: map[string]string{"Authorization": "fixture-secret"}}}
	d.config.Skills = map[string]SkillConfig{"review": {Name: "review", Body: "Selected skill instructions", Enabled: true}}
	rec := &SessionRecord{ID: "mcp-turn", CWD: t.TempDir(), Model: "m", Status: "idle", Options: SessionOptions{Mode: "build", Skills: []string{"review"}, Access: "full"}}
	act := &ActiveSession{record: rec}
	d.sessions[rec.ID] = act
	done := make(chan struct{})
	go func() { d.runAgentTurn(act, "Inspect remote item", "m", true, nil); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("MCP turn did not complete")
	}
	disk, err := d.loadSession(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(disk.Messages)
	if requests.Load() != 2 || calls.Load() != 1 || disk.Status != "idle" || !strings.Contains(string(data), "Remote item inspected") {
		t.Fatal("MCP turn execution/persistence failed")
	}
}
