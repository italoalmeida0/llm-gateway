package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func rpcResult(method string, params json.RawMessage) any {
	switch method {
	case "initialize":
		return map[string]any{"protocolVersion": ProtocolVersion, "capabilities": map[string]any{"tools": map[string]any{}}}
	case "tools/list":
		var p struct {
			Cursor string `json:"cursor"`
		}
		_ = json.Unmarshal(params, &p)
		if p.Cursor == "" {
			return map[string]any{"tools": []any{map[string]any{"name": "first", "description": "A tool", "inputSchema": map[string]any{"type": "object"}}}, "nextCursor": "page2"}
		}
		return map[string]any{"tools": []any{map[string]any{"name": "second", "inputSchema": map[string]any{"type": "object"}}}}
	default:
		return map[string]any{"content": []any{map[string]any{"type": "text", "text": "done"}}, "structuredContent": map[string]any{"ok": true}}
	}
}
func TestStdioHelper(t *testing.T) {
	if os.Getenv("INDIRECT_MCP_TEST_HELPER") != "yes" {
		return
	}
	reader := bufio.NewScanner(os.Stdin)
	for reader.Scan() {
		var msg envelope
		if json.Unmarshal(reader.Bytes(), &msg) != nil {
			os.Exit(2)
		}
		if len(msg.ID) == 0 {
			continue
		}
		if msg.Method == "tools/call" && os.Getenv("INDIRECT_MCP_TEST_HANG") == "yes" {
			select {}
		}
		result := rpcResult(msg.Method, msg.Params)
		if msg.Method == "tools/call" {
			cwd, _ := os.Getwd()
			result = map[string]any{"content": []any{map[string]any{"type": "text", "text": cwd + "|" + os.Getenv("INDIRECT_MCP_TEST_VALUE")}}}
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": result})
	}
	os.Exit(0)
}
func TestStdioLifecycleArgumentsEnvironmentAndCancellation(t *testing.T) {
	exe, _ := os.Executable()
	cwd := t.TempDir()
	cfg := Config{Command: exe, Args: []string{"-test.run=^TestStdioHelper$"}, Env: map[string]string{"INDIRECT_MCP_TEST_HELPER": "yes", "INDIRECT_MCP_TEST_VALUE": "value with spaces"}}
	client, err := Connect(context.Background(), cfg, cwd)
	if err != nil {
		t.Fatal(err)
	}
	list, err := client.Tools(context.Background())
	if err != nil || len(list) != 2 {
		t.Fatalf("pagination: %v %d", err, len(list))
	}
	result, err := client.Call(context.Background(), "first", json.RawMessage(`{"path":"a b"}`))
	if err != nil || result.Content[0].Text != cwd+"|value with spaces" {
		t.Fatalf("stdio: %v %+v", err, result)
	}
	client.Close()
	select {
	case <-client.done:
	case <-time.After(2 * time.Second):
		t.Fatal("stdio process survived close")
	}
	cfg.Env["INDIRECT_MCP_TEST_HANG"] = "yes"
	client, err = Connect(context.Background(), cfg, cwd)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err = client.Call(ctx, "first", json.RawMessage(`{}`))
	if err == nil || client.Alive() {
		t.Fatal("cancelled call remained live")
	}
}
func TestStreamableHTTPJSONAndSSE(t *testing.T) {
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprint(stream), func(t *testing.T) {
			var calls atomic.Int32
			var initialized atomic.Bool
			var deleted atomic.Bool
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer fixture-secret" {
					t.Error("missing authentication")
				}
				if r.Method == http.MethodDelete {
					deleted.Store(true)
					w.WriteHeader(200)
					return
				}
				var msg envelope
				if json.NewDecoder(r.Body).Decode(&msg) != nil {
					t.Error("invalid request")
					w.WriteHeader(400)
					return
				}
				if msg.Method != "initialize" && (r.Header.Get("Mcp-Session-Id") != "session" || r.Header.Get("MCP-Protocol-Version") != ProtocolVersion) {
					t.Error("negotiated headers missing")
				}
				if msg.Method == "notifications/initialized" {
					initialized.Store(true)
					w.WriteHeader(202)
					return
				}
				if msg.Method == "tools/call" {
					calls.Add(1)
				}
				if msg.Method != "initialize" && !initialized.Load() {
					t.Error("tools used before initialized")
				}
				w.Header().Set("Mcp-Session-Id", "session")
				reply := map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": rpcResult(msg.Method, msg.Params)}
				if stream {
					w.Header().Set("Content-Type", "text/event-stream")
					if msg.Method == "tools/call" {
						fmt.Fprint(w, "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n\n")
					}
					data, _ := json.Marshal(reply)
					fmt.Fprintf(w, "event: message\ndata: %s\n\n", data)
					w.(http.Flusher).Flush()
					<-r.Context().Done() // The client must stop reading after the response.
				} else {
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(reply)
				}
			}))
			defer server.Close()
			client, err := Connect(context.Background(), Config{Transport: "http", URL: server.URL, Headers: map[string]string{"Authorization": "Bearer fixture-secret"}}, "")
			if err != nil {
				t.Fatal(err)
			}
			list, err := client.Tools(context.Background())
			if err != nil || len(list) != 2 {
				t.Fatalf("list: %v", err)
			}
			result, err := client.Call(context.Background(), "first", json.RawMessage(`{}`))
			if err != nil || len(result.Content) != 1 || calls.Load() != 1 {
				t.Fatalf("call: %v", err)
			}
			if stream && !client.Changed() {
				t.Fatal("list change notification lost")
			}
			client.Close()
			if !deleted.Load() {
				t.Fatal("session was not terminated")
			}
		})
	}
}
func TestLegacySSE(t *testing.T) {
	events := make(chan []byte, 8)
	var callCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "event: endpoint\ndata: /messages\n\n")
			w.(http.Flusher).Flush()
			for {
				select {
				case event := <-events:
					fmt.Fprintf(w, "event: message\ndata: %s\n\n", event)
					w.(http.Flusher).Flush()
				case <-r.Context().Done():
					return
				}
			}
		}
		if r.URL.Path != "/messages" {
			t.Error("wrong endpoint")
		}
		var msg envelope
		_ = json.NewDecoder(r.Body).Decode(&msg)
		if msg.Method == "tools/call" {
			callCount.Add(1)
		}
		if len(msg.ID) > 0 {
			reply, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": rpcResult(msg.Method, msg.Params)})
			events <- reply
		}
		w.WriteHeader(202)
	}))
	defer server.Close()
	client, err := Connect(context.Background(), Config{Transport: "sse", URL: server.URL}, "")
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	list, err := client.Tools(context.Background())
	if err != nil || len(list) != 2 {
		t.Fatal(err)
	}
	_, err = client.Call(context.Background(), "first", json.RawMessage(`{}`))
	if err != nil || callCount.Load() != 1 {
		t.Fatal(err)
	}
}
func TestHTTPFailuresAreBoundedRedactedAndNotReplayed(t *testing.T) {
	for _, kind := range []string{"failure", "oversize", "invalid-sse", "wrong-id", "redirect"} {
		t.Run(kind, func(t *testing.T) {
			var count atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "DELETE" {
					w.WriteHeader(405)
					return
				}
				var msg envelope
				_ = json.NewDecoder(r.Body).Decode(&msg)
				if msg.Method == "notifications/initialized" {
					w.WriteHeader(202)
					return
				}
				if msg.Method == "initialize" {
					_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": rpcResult(msg.Method, msg.Params)})
					return
				}
				count.Add(1)
				switch kind {
				case "failure":
					w.WriteHeader(401)
					fmt.Fprint(w, "fixture-secret")
				case "oversize":
					fmt.Fprint(w, strings.Repeat("x", MaxMessageBytes+1))
				case "invalid-sse":
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, "data: invalid\n\n")
				case "wrong-id":
					fmt.Fprint(w, `{"jsonrpc":"2.0","id":999,"result":{}}`)
				case "redirect":
					w.Header().Set("Location", "/fixture-secret")
					w.WriteHeader(307)
				}
			}))
			defer server.Close()
			client, err := Connect(context.Background(), Config{Transport: "http", URL: server.URL + "/fixture-secret"}, "")
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, err = client.Call(ctx, "first", json.RawMessage(`{}`))
			if err == nil || strings.Contains(err.Error(), "fixture-secret") || count.Load() != 1 {
				t.Fatalf("unsafe failure: %v (%d calls)", err, count.Load())
			}
		})
	}
}
func TestValidationAndConcurrentCalls(t *testing.T) {
	for _, cfg := range []Config{{Command: ""}, {Transport: "http", URL: "file:///secret"}, {Transport: "http", URL: "https://user:secret@example.com"}, {Command: "exe", Env: map[string]string{"BAD=KEY": "secret"}}, {Command: "exe", Headers: map[string]string{"Authorization": "x\ny"}}} {
		if Validate(cfg) == nil {
			t.Fatal("invalid config accepted")
		}
	}
	exe, _ := os.Executable()
	client, err := Connect(context.Background(), Config{Command: exe, Args: []string{"-test.run=^TestStdioHelper$"}, Env: map[string]string{"INDIRECT_MCP_TEST_HELPER": "yes"}}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := client.Call(context.Background(), "first", json.RawMessage(`{}`))
			if err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
}

func TestInitializationCapabilitiesVersionAndSetupDeadline(t *testing.T) {
	for _, kind := range []string{"unsupported-version", "no-tools", "old-version", "slow-headers", "slow-sse-headers"} {
		t.Run(kind, func(t *testing.T) {
			release := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(kind, "slow-") {
					select {
					case <-release:
					case <-r.Context().Done():
					}
					return
				}
				var msg envelope
				_ = json.NewDecoder(r.Body).Decode(&msg)
				if msg.Method == "notifications/initialized" {
					w.WriteHeader(202)
					return
				}
				version := ProtocolVersion
				caps := map[string]any{"tools": map[string]any{}}
				if kind == "unsupported-version" {
					version = "2099-01-01"
				}
				if kind == "no-tools" {
					caps = map[string]any{"resources": map[string]any{}}
				}
				if kind == "old-version" {
					version = "2024-11-05"
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": map[string]any{"protocolVersion": version, "capabilities": caps}})
			}))
			defer func() { close(release); server.Close() }()
			ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
			defer cancel()
			transport := "http"
			if kind == "slow-sse-headers" {
				transport = "sse"
			}
			started := time.Now()
			client, err := ConnectWithSetup(context.Background(), ctx, Config{Transport: transport, URL: server.URL}, "")
			if time.Since(started) > time.Second {
				t.Error("setup deadline was not honored")
			}
			if client != nil {
				defer client.Close()
			}
			if kind == "old-version" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil {
				t.Fatal("invalid or timed out initialization accepted")
			}
		})
	}
}
func TestPaginationValidation(t *testing.T) {
	for _, kind := range []string{"repeated-cursor", "duplicate-name", "bad-schema"} {
		t.Run(kind, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var msg envelope
				_ = json.NewDecoder(r.Body).Decode(&msg)
				if len(msg.ID) == 0 {
					w.WriteHeader(202)
					return
				}
				result := rpcResult(msg.Method, msg.Params)
				if msg.Method == "tools/list" {
					var tools = []any{map[string]any{"name": "same", "inputSchema": map[string]any{"type": "object"}}}
					next := "again"
					if kind == "repeated-cursor" {
						tools = []any{}
					}
					if kind == "bad-schema" {
						tools = []any{map[string]any{"name": "bad", "inputSchema": map[string]any{"type": "string"}}}
						next = ""
					}
					result = map[string]any{"tools": tools, "nextCursor": next}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": result})
			}))
			defer server.Close()
			client, err := Connect(context.Background(), Config{Transport: "http", URL: server.URL}, "")
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			if _, err = client.Tools(context.Background()); err == nil {
				t.Fatal("invalid catalog accepted")
			}
		})
	}
}
