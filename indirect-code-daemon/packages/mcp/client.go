// Package mcp implements the tools capability over stdio, Streamable HTTP and
// legacy HTTP+SSE. Tool calls are never replayed after an ambiguous failure.
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const MaxMessageBytes = 4 << 20
const ProtocolVersion = "2025-11-25"

type Config struct {
	Command   string            `json:"command,omitempty"`
	Args      []string          `json:"args,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	Transport string            `json:"transport,omitempty"`
	URL       string            `json:"url,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"`
	Disabled  bool              `json:"disabled,omitempty"`
}

type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}
type Content struct {
	Type     string          `json:"type"`
	Text     string          `json:"text,omitempty"`
	Data     string          `json:"data,omitempty"`
	MimeType string          `json:"mimeType,omitempty"`
	URI      string          `json:"uri,omitempty"`
	Name     string          `json:"name,omitempty"`
	Resource json.RawMessage `json:"resource,omitempty"`
}
type Result struct {
	Content           []Content       `json:"content"`
	StructuredContent json.RawMessage `json:"structuredContent,omitempty"`
	IsError           bool            `json:"isError,omitempty"`
}

type envelope struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type Client struct {
	cfg       Config
	ctx       context.Context
	cancel    context.CancelFunc
	http      *http.Client
	writer    io.WriteCloser
	cmd       *exec.Cmd
	done      chan struct{}
	sendMu    sync.Mutex
	mu        sync.Mutex
	pending   map[string]chan envelope
	endpoint  string
	session   string
	version   string
	seq       atomic.Int64
	failed    atomic.Bool
	changed   atomic.Bool
	closeOnce sync.Once
}

// Errors intentionally omit commands, URLs, headers, stderr and remote error
// bodies: credentials can appear in any of those fields.
func Connect(parent context.Context, cfg Config, cwd string) (*Client, error) {
	return ConnectWithSetup(parent, parent, cfg, cwd)
}

// The setup deadline bounds discovery without shortening the connection's
// lifetime after initialization succeeds.
func ConnectWithSetup(parent, setupParent context.Context, cfg Config, cwd string) (*Client, error) {
	if err := Validate(cfg); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	c := &Client{cfg: cfg, ctx: ctx, cancel: cancel, pending: map[string]chan envelope{}, endpoint: cfg.URL, done: make(chan struct{})}
	c.http = &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, ResponseHeaderTimeout: 15 * time.Second}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	setup, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	cancelOnTimeout := context.AfterFunc(setup, c.cancel)
	defer cancelOnTimeout()
	unlink := context.AfterFunc(setupParent, stop)
	defer unlink()
	if setupParent.Err() != nil {
		c.Close()
		return nil, errors.New("MCP initialization cancelled")
	}
	var err error
	switch cfg.Transport {
	case "", "stdio":
		command, lookupErr := executablePath(cfg, cwd)
		if lookupErr != nil {
			c.Close()
			return nil, errors.New("MCP executable was not found in PATH")
		}
		c.cmd = exec.CommandContext(ctx, command, cfg.Args...)
		prepareProcess(c.cmd)
		c.cmd.Dir = cwd
		c.cmd.Env = os.Environ()
		for k, v := range cfg.Env {
			c.cmd.Env = append(c.cmd.Env, k+"="+v)
		}
		c.cmd.Stderr = io.Discard
		c.writer, err = c.cmd.StdinPipe()
		if err == nil {
			var reader io.ReadCloser
			reader, err = c.cmd.StdoutPipe()
			if err == nil {
				err = c.cmd.Start()
				if err == nil {
					go func() { c.readLines(reader); c.failed.Store(true); c.cancel() }()
					go func() { _ = c.cmd.Wait(); close(c.done) }()
				} else {
					_ = reader.Close()
				}
			}
		}
	case "http", "streamable-http":
	case "sse":
		err = c.openSSE(setup)
	default:
		err = errors.New("Unsupported MCP transport")
	}
	if err != nil {
		c.Close()
		return nil, errors.New("Could not start MCP connection")
	}
	var init struct {
		ProtocolVersion string `json:"protocolVersion"`
		Capabilities    struct {
			Tools *json.RawMessage `json:"tools"`
		} `json:"capabilities"`
	}
	err = c.request(setup, "initialize", map[string]any{"protocolVersion": ProtocolVersion, "capabilities": map[string]any{}, "clientInfo": map[string]string{"name": "indirect-code", "version": "1.0"}}, &init)
	if err == nil {
		switch init.ProtocolVersion {
		case ProtocolVersion, "2025-06-18", "2025-03-26", "2024-11-05":
			c.mu.Lock()
			c.version = init.ProtocolVersion
			c.mu.Unlock()
		default:
			err = errors.New("Unsupported MCP protocol version")
		}
	}
	if err == nil && init.Capabilities.Tools == nil {
		err = errors.New("MCP server does not provide tools")
	}
	if err == nil {
		err = c.notify(setup, "notifications/initialized", nil)
	}
	if err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

func (c *Client) Alive() bool   { return c.ctx.Err() == nil && !c.failed.Load() }
func (c *Client) Changed() bool { return c.changed.Swap(false) }
func (c *Client) Close() {
	c.closeOnce.Do(func() {
		if c.writer != nil {
			_ = c.writer.Close()
		}
		c.cancel()
		if c.cmd != nil && c.cmd.Process != nil {
			_ = c.cmd.Cancel()
			select {
			case <-c.done:
			case <-time.After(time.Second):
			}
		}
		c.mu.Lock()
		session, endpoint := c.session, c.endpoint
		c.mu.Unlock()
		if session != "" && (c.cfg.Transport == "http" || c.cfg.Transport == "streamable-http") {
			ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
			if response, err := c.httpRequest(ctx, http.MethodDelete, endpoint, nil); err == nil {
				_ = response.Body.Close()
			}
			cancel()
		}
		c.http.CloseIdleConnections()
	})
}

func (c *Client) readLines(reader io.Reader) {
	scan := bufio.NewScanner(reader)
	scan.Buffer(make([]byte, 4096), MaxMessageBytes)
	for scan.Scan() {
		if len(bytes.TrimSpace(scan.Bytes())) == 0 {
			continue
		}
		if !c.receive(scan.Bytes()) {
			return
		}
	}
}
func (c *Client) receive(data []byte) bool {
	var msg envelope
	if json.Unmarshal(data, &msg) != nil || msg.JSONRPC != "2.0" {
		return false
	}
	if msg.Method != "" {
		if msg.Method == "notifications/tools/list_changed" {
			c.changed.Store(true)
		}
		if len(msg.ID) > 0 { // No client sampling/elicitation/roots capability is advertised.
			response := map[string]any{"jsonrpc": "2.0", "id": msg.ID}
			if msg.Method == "ping" {
				response["result"] = map[string]any{}
			} else {
				response["error"] = map[string]any{"code": -32601, "message": "Client method not supported"}
			}
			go func() {
				ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
				defer cancel()
				_ = c.send(ctx, response, false)
			}()
		}
		return true
	}
	if len(msg.ID) == 0 {
		return true
	}
	c.mu.Lock()
	ch := c.pending[string(msg.ID)]
	c.mu.Unlock()
	if ch != nil {
		select {
		case ch <- msg:
		default:
		}
	}
	return true
}
func (c *Client) request(ctx context.Context, method string, params any, result any) error {
	if !c.Alive() {
		return errors.New("MCP connection is closed")
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	id := c.seq.Add(1)
	key := fmt.Sprint(id)
	ch := make(chan envelope, 1)
	c.mu.Lock()
	c.pending[key] = ch
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.pending, key); c.mu.Unlock() }()
	if err := c.send(ctx, map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}, true); err != nil {
		c.failed.Store(true)
		return err
	}
	select {
	case msg := <-ch:
		if msg.Error != nil {
			return fmt.Errorf("MCP request rejected (code %d)", msg.Error.Code)
		}
		if len(msg.Result) == 0 || json.Unmarshal(msg.Result, result) != nil {
			return errors.New("Invalid MCP result")
		}
		return nil
	case <-ctx.Done():
		c.failed.Store(true)
		// Close a stuck transport rather than risk reusing an incomplete request.
		c.Close()
		return errors.New("MCP request cancelled or timed out; it was not retried")
	case <-c.ctx.Done():
		return errors.New("MCP connection closed; request was not retried")
	}
}
func (c *Client) notify(ctx context.Context, method string, params any) error {
	msg := map[string]any{"jsonrpc": "2.0", "method": method}
	if params != nil {
		msg["params"] = params
	}
	return c.send(ctx, msg, false)
}
func (c *Client) send(ctx context.Context, msg any, expectResponse bool) error {
	data, err := json.Marshal(msg)
	if err != nil || len(data) > MaxMessageBytes {
		return errors.New("MCP request exceeds message limit")
	}
	if c.writer != nil {
		finished := make(chan error, 1)
		go func() {
			c.sendMu.Lock()
			defer c.sendMu.Unlock()
			_, err := c.writer.Write(append(data, '\n'))
			finished <- err
		}()
		select {
		case err := <-finished:
			if err != nil {
				return errors.New("MCP input closed")
			}
			return nil
		case <-ctx.Done():
			c.Close()
			return errors.New("MCP write cancelled")
		}
	}
	c.mu.Lock()
	endpoint := c.endpoint
	c.mu.Unlock()
	response, err := c.httpRequest(ctx, http.MethodPost, endpoint, data)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("MCP HTTP request failed (status %d)", response.StatusCode)
	}
	if session := response.Header.Get("Mcp-Session-Id"); session != "" {
		c.mu.Lock()
		c.session = session
		c.mu.Unlock()
	}
	if c.cfg.Transport == "sse" || !expectResponse {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, MaxMessageBytes))
		return nil
	}
	if strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		// Stop reading when this POST's response arrives; the server may keep its
		// SSE response stream open indefinitely after the final JSON-RPC result.
		var request struct {
			ID json.RawMessage `json:"id"`
		}
		_ = json.Unmarshal(data, &request)
		received := false
		streamErr := readSSE(response.Body, func(event, body string) bool {
			if event != "message" && event != "" {
				return true
			}
			if !c.receive([]byte(body)) {
				return false
			}
			var reply envelope
			_ = json.Unmarshal([]byte(body), &reply)
			received = reply.Method == "" && string(reply.ID) == string(request.ID)
			return !received
		})
		if streamErr != nil {
			return streamErr
		}
		if !received {
			return errors.New("MCP stream ended before a valid response arrived")
		}
		return nil
	}
	data, err = io.ReadAll(io.LimitReader(response.Body, MaxMessageBytes+1))
	var request, reply envelope
	requestData, _ := json.Marshal(msg)
	_ = json.Unmarshal(requestData, &request)
	_ = json.Unmarshal(data, &reply)
	if err != nil || len(data) > MaxMessageBytes || reply.Method != "" || string(reply.ID) != string(request.ID) || !c.receive(data) {
		return errors.New("Invalid MCP HTTP response")
	}
	return nil
}
func (c *Client) httpRequest(ctx context.Context, method, target string, data []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(data))
	if err != nil {
		return nil, errors.New("Invalid MCP URL")
	}
	for k, v := range c.cfg.Headers {
		req.Header.Set(k, v)
	}
	req.Header.Set("Accept", "application/json, text/event-stream")
	if data != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	c.mu.Lock()
	session, version := c.session, c.version
	c.mu.Unlock()
	if session != "" {
		req.Header.Set("Mcp-Session-Id", session)
	}
	if version != "" {
		req.Header.Set("MCP-Protocol-Version", version)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, errors.New("MCP network request failed")
	}
	return resp, nil
}
func (c *Client) openSSE(setup context.Context) error {
	response, err := c.httpRequest(c.ctx, http.MethodGet, c.cfg.URL, nil)
	if err != nil {
		return err
	}
	if response.StatusCode != 200 {
		response.Body.Close()
		return errors.New("MCP SSE endpoint unavailable")
	}
	endpoints := make(chan string, 1)
	go func() {
		defer response.Body.Close()
		defer c.failed.Store(true)
		defer c.cancel()
		_ = readSSE(response.Body, func(event, body string) bool {
			if event == "endpoint" {
				select {
				case endpoints <- body:
				default:
				}
				return true
			}
			return event != "message" || c.receive([]byte(body))
		})
	}()
	select {
	case endpoint := <-endpoints:
		base, _ := url.Parse(c.cfg.URL)
		relative, err := url.Parse(endpoint)
		if err != nil {
			return errors.New("Invalid MCP SSE endpoint")
		}
		resolved := base.ResolveReference(relative)
		if resolved.Scheme != base.Scheme || resolved.Host != base.Host || resolved.User != nil {
			return errors.New("MCP SSE endpoint must use the same origin")
		}
		c.mu.Lock()
		c.endpoint = resolved.String()
		c.mu.Unlock()
		return nil
	case <-setup.Done():
		return errors.New("MCP SSE initialization timed out")
	case <-c.ctx.Done():
		return errors.New("MCP SSE connection closed")
	}
}
func readSSE(reader io.Reader, onEvent func(string, string) bool) error {
	scan := bufio.NewScanner(reader)
	scan.Buffer(make([]byte, 4096), MaxMessageBytes)
	var event string
	var data strings.Builder
	for scan.Scan() {
		line := scan.Text()
		if line == "" {
			if data.Len() > 0 && !onEvent(event, strings.TrimSuffix(data.String(), "\n")) {
				return nil
			}
			event = ""
			data.Reset()
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		value = strings.TrimPrefix(value, " ")
		if key == "event" {
			event = value
		}
		if key == "data" {
			if data.Len()+len(value) > MaxMessageBytes {
				return errors.New("MCP SSE message too large")
			}
			data.WriteString(value)
			data.WriteByte('\n')
		}
	}
	if scan.Err() != nil {
		return errors.New("MCP SSE stream failed")
	}
	return nil
}
func (c *Client) Tools(ctx context.Context) ([]Tool, error) {
	var tools []Tool
	cursor := ""
	seen := map[string]bool{}
	names := map[string]bool{}
	for page := 0; page < 32; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		var result struct {
			Tools []Tool `json:"tools"`
			Next  string `json:"nextCursor"`
		}
		if err := c.request(ctx, "tools/list", params, &result); err != nil {
			return nil, err
		}
		for _, tool := range result.Tools {
			if tool.Name == "" || len(tool.Name) > 256 || len(tool.Description) > 8192 || names[tool.Name] || len(tool.InputSchema) > 65536 {
				return nil, errors.New("Invalid or duplicate MCP tool")
			}
			var schema map[string]any
			if json.Unmarshal(tool.InputSchema, &schema) != nil || schema["type"] != "object" {
				return nil, errors.New("Invalid MCP tool schema")
			}
			names[tool.Name] = true
			tools = append(tools, tool)
			if len(tools) > 256 {
				return nil, errors.New("MCP tool limit exceeded")
			}
		}
		if result.Next == "" {
			return tools, nil
		}
		if seen[result.Next] {
			return nil, errors.New("Repeated MCP pagination cursor")
		}
		seen[result.Next] = true
		cursor = result.Next
	}
	return nil, errors.New("MCP pagination limit exceeded")
}
func (c *Client) Call(ctx context.Context, name string, args json.RawMessage) (Result, error) {
	var result Result
	err := c.request(ctx, "tools/call", map[string]any{"name": name, "arguments": args}, &result)
	return result, err
}
