package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/mcp"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

type mcpConnection struct {
	config      MCPServerConfig
	fingerprint string
	client      *mcp.Client
	tools       []mcp.Tool
	retryAt     time.Time
	errorText   string
}

func mcpFingerprint(cfg MCPServerConfig) string {
	data, _ := json.Marshal(cfg)
	return fmt.Sprintf("%x", sha256.Sum256(data))
}
func mcpToolName(server, tool string) string {
	clean := func(s string) string {
		var b strings.Builder
		for _, r := range s {
			if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' {
				b.WriteRune(r)
			} else {
				b.WriteByte('_')
			}
		}
		text := b.String()
		if len(text) > 20 {
			text = text[:20]
		}
		return text
	}
	sum := sha256.Sum256([]byte(server + "\x00" + tool))
	return fmt.Sprintf("mcp__%s__%s_%x", clean(server), clean(tool), sum[:6])
}

func (r *turnRun) closeMCP() {
	for _, state := range r.mcp {
		if state.client != nil {
			state.client.Close()
		}
	}
	r.mcp = nil
}
func (r *turnRun) mcpStatus(name, status string, count int, message string) {
	_ = r.d.sendWS(map[string]any{"type": "mcp_status", "hostId": r.cfg.HostID, "sessionId": r.sessionID, "name": name, "status": status, "toolCount": count, "message": message})
}

// Connections belong to a turn. Failed discovery is retried on a later model
// request; tools/call is never replayed by the transport.
func (r *turnRun) syncMCP(ctx context.Context, cfg DaemonConfig, options SessionOptions, reg core.Registry) {
	if r.mcp == nil {
		r.mcp = map[string]*mcpConnection{}
	}
	allowed := options.Mode == "build" && !cfg.Settings.JailByDefault
	for name, state := range r.mcp {
		server, exists := cfg.MCPServers[name]
		if !allowed || !exists || server.Disabled || state.fingerprint != mcpFingerprint(server) {
			if state.client != nil {
				state.client.Close()
			}
			delete(r.mcp, name)
		}
	}
	if !allowed {
		return
	}
	// Bound total startup latency and process/network fan-out for many servers.
	batchCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	slots := make(chan struct{}, 4)
	for _, name := range sortedKeys(cfg.MCPServers) {
		server := cfg.MCPServers[name]
		if server.Disabled {
			continue
		}
		state := r.mcp[name]
		if state == nil {
			state = &mcpConnection{config: server, fingerprint: mcpFingerprint(server)}
			r.mcp[name] = state
		}
		refresh := state.client == nil || !state.client.Alive() || state.client.Changed()
		if !refresh || time.Now().Before(state.retryAt) {
			continue
		}
		wg.Add(1)
		go func(name string, state *mcpConnection) {
			defer wg.Done()
			select {
			case slots <- struct{}{}:
				defer func() { <-slots }()
			case <-batchCtx.Done():
				state.errorText = "MCP discovery deadline reached"
				state.retryAt = time.Now().Add(30 * time.Second)
				return
			}
			r.mcpStatus(name, "connecting", 0, "")
			var err error
			if state.client == nil || !state.client.Alive() {
				if state.client != nil {
					state.client.Close()
				}
				state.client, err = mcp.ConnectWithSetup(r.ctx, batchCtx, state.config, r.sessionCWD)
			}
			if err == nil {
				discover, stop := context.WithTimeout(batchCtx, 15*time.Second)
				state.tools, err = state.client.Tools(discover)
				stop()
			}
			if err != nil {
				if state.client != nil {
					state.client.Close()
					state.client = nil
				}
				state.tools = nil
				state.retryAt = time.Now().Add(30 * time.Second)
				state.errorText = err.Error()
				r.mcpStatus(name, "error", 0, state.errorText)
				return
			}
			state.retryAt = time.Time{}
			state.errorText = ""
			r.mcpStatus(name, "connected", len(state.tools), "")
		}(name, state)
	}
	wg.Wait()
	count := 0
	for _, name := range sortedKeys(r.mcp) {
		state := r.mcp[name]
		if state.client == nil || !state.client.Alive() {
			continue
		}
		for _, spec := range state.tools {
			if count >= 256 {
				r.mcpStatus(name, "limited", len(state.tools), "The combined MCP tool limit is 256")
				break
			}
			tool := &mcpAgentTool{run: r, server: name, state: state, spec: spec}
			reg[tool.Name()] = tool
			count++
		}
	}

}

type mcpAgentTool struct {
	run    *turnRun
	server string
	state  *mcpConnection
	spec   mcp.Tool
}

func (t *mcpAgentTool) Name() string { return mcpToolName(t.server, t.spec.Name) }
func (t *mcpAgentTool) Description() string {
	return "MCP server " + t.server + ": " + t.spec.Description
}
func (t *mcpAgentTool) Schema() json.RawMessage { return t.spec.InputSchema }
func (t *mcpAgentTool) Execute(ctx context.Context, args json.RawMessage, _ func(string)) (core.ToolResult, error) {
	r := t.run
	// Recheck after approval and between tools in a batch. A removed/disabled
	// server or a mode/jail change must never execute an old advertised tool.
	r.d.configMu.RLock()
	cfg, exists := r.d.config.MCPServers[t.server]
	blocked := !exists || cfg.Disabled || r.d.config.Settings.JailByDefault || mcpFingerprint(cfg) != t.state.fingerprint
	r.d.configMu.RUnlock()
	r.act.mu.Lock()
	blocked = blocked || r.act.gen != r.myGen || normalizedOptions(r.act.record.Options).Mode != "build"
	r.act.mu.Unlock()
	if blocked {
		return core.ToolResult{}, errors.New("MCP tool is no longer available under the current configuration or session mode")
	}
	result, err := t.state.client.Call(ctx, t.spec.Name, args)
	if err != nil {
		r.mcpStatus(t.server, "error", 0, err.Error())
		return core.ToolResult{}, fmt.Errorf("%w. The execution outcome may be unknown; check external state before repeating the action", err)
	}
	return mcpToolResult(result), nil
}
func mcpToolResult(result mcp.Result) core.ToolResult {
	out := core.ToolResult{IsError: result.IsError}
	add := func(text string) {
		if text != "" {
			out.Content = append(out.Content, provider.TextBlock{Text: text})
		}
	}
	for _, item := range result.Content {
		switch item.Type {
		case "text":
			add(item.Text)
		case "image":
			switch item.MimeType {
			case "image/png", "image/jpeg", "image/gif", "image/webp":
				data, err := base64.StdEncoding.DecodeString(item.Data)
				if err == nil {
					out.Content = append(out.Content, provider.ImageBlock{MimeType: item.MimeType, Data: data})
				} else {
					add("[Invalid MCP image omitted]")
				}
			default:
				add("[Unsupported MCP image format omitted]")
			}
		case "resource_link":
			add(item.Name + ": " + item.URI)
		case "resource":
			var resource struct {
				URI  string `json:"uri"`
				Text string `json:"text"`
			}
			if json.Unmarshal(item.Resource, &resource) == nil {
				add(resource.URI)
				add(resource.Text)
			}
		default:
			add("[Unsupported MCP content omitted]")
		}
	}
	if len(result.StructuredContent) > 0 && string(result.StructuredContent) != "null" {
		add(string(result.StructuredContent))
	}
	if len(out.Content) == 0 {
		add("MCP tool completed with no displayable content.")
	}
	return out
}

// Manual discovery tests never invoke tools. The dispatcher holds configMu,
// so copy the request and release it before any network/process work.
func (d *DaemonServer) testMCP(raw []byte) {
	var req struct {
		RequestID        string          `json:"requestId"`
		ExpectedRevision string          `json:"expectedRevision"`
		Name             string          `json:"name"`
		Server           MCPServerConfig `json:"server"`
	}
	err := json.Unmarshal(raw, &req)
	hostID := d.config.HostID
	reply := func(status string, count int, message string) {
		_ = d.sendWS(map[string]any{"type": "mcp_status", "hostId": hostID, "requestId": req.RequestID, "name": req.Name, "status": status, "toolCount": count, "message": message})
	}
	if err != nil || !mcp.ValidName(req.Name) || len(raw) > 2<<20 {
		reply("error", 0, "Invalid MCP configuration")
		return
	}
	if req.ExpectedRevision != "" && req.ExpectedRevision != configRevision(d.config) {
		reply("error", 0, "Settings changed on another client. Reload them before testing this connection.")
		return
	}
	req.Server = d.mergeMCPSecrets(req.Name, req.Server)
	if err = mcp.Validate(req.Server); err != nil {
		reply("error", 0, err.Error())
		return
	}
	if !d.mcpTestBusy.CompareAndSwap(false, true) {
		reply("error", 0, "Another MCP connection test is running")
		return
	}
	go func() {
		defer d.mcpTestBusy.Store(false)
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		cwd, _ := os.UserHomeDir()
		client, err := mcp.Connect(ctx, req.Server, cwd)
		if err != nil {
			reply("error", 0, err.Error())
			return
		}
		defer client.Close()
		list, err := client.Tools(ctx)
		if err != nil {
			reply("error", 0, err.Error())
			return
		}
		reply("tested", len(list), "Connection and tool discovery succeeded. No tool was invoked.")
	}()
}

func (r *turnRun) mcpAvailability() string {
	var out strings.Builder
	for _, name := range sortedKeys(r.mcp) {
		state := r.mcp[name]
		if state.errorText != "" {
			fmt.Fprintf(&out, "\nMCP server %s is unavailable: %s. Do not assume its tools were loaded.\n", name, state.errorText)
		}
	}
	return out.String()
}
