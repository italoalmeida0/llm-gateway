package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

func waitConvert(t *testing.T, act *ActiveSession) string {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		act.mu.Lock()
		id := ""
		if act.convert != nil {
			id = act.convert.ID
		}
		act.mu.Unlock()
		if id != "" {
			return id
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("convert request did not reach the session")
	return ""
}

func TestConvertWaitsForValidResponseAndIgnoresStale(t *testing.T) {
	d := testDaemon(t)
	act := &ActiveSession{record: &SessionRecord{ID: "conv", Status: "running", Options: SessionOptions{Access: "full"}}, gen: 1}
	d.sessions[act.record.ID] = act
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	type reply struct {
		text string
		err  error
	}
	result := make(chan reply, 1)
	go func() {
		text, err := d.requestFileConvert(ctx, act, 1, d.config.HostID, "doc.pdf", base64.StdEncoding.EncodeToString([]byte("%PDF-1.4 fake")))
		result <- reply{text, err}
	}()
	id := waitConvert(t, act)
	respond := func(id, text, errMsg string) {
		raw, _ := json.Marshal(map[string]any{"type": "convert_response", "sessionId": "conv", "requestId": id, "text": text, "error": errMsg})
		d.handleMessage(raw)
	}
	respond("stale-id", "stale", "")
	select {
	case <-result:
		t.Fatal("stale response resumed the turn")
	default:
	}
	respond(id, "# Converted\nhello", "")
	select {
	case got := <-result:
		if got.err != nil || got.text != "# Converted\nhello" {
			t.Fatalf("wrong reply: %+v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("convert response did not resume the tool")
	}
	act.mu.Lock()
	defer act.mu.Unlock()
	if act.convert != nil {
		t.Fatal("response left a pending conversion")
	}
}

func TestConvertErrorFallsBack(t *testing.T) {
	d := testDaemon(t)
	act := &ActiveSession{record: &SessionRecord{ID: "conv-err", Status: "running", Options: SessionOptions{Access: "full"}}, gen: 1}
	d.sessions[act.record.ID] = act
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, err := d.requestFileConvert(ctx, act, 1, d.config.HostID, "doc.pdf", base64.StdEncoding.EncodeToString([]byte("%PDF-1.4 fake")))
		result <- err
	}()
	id := waitConvert(t, act)
	raw, _ := json.Marshal(map[string]any{"type": "convert_response", "sessionId": "conv-err", "requestId": id, "error": "No text extracted"})
	d.handleMessage(raw)
	select {
	case err := <-result:
		if err == nil || !strings.Contains(err.Error(), "No text extracted") {
			t.Fatalf("wrong error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("convert error did not resume the tool")
	}
}

func TestReadFallsBackWithoutBrowser(t *testing.T) {
	dir := t.TempDir()
	// Minimal PDF header + null byte so looksBinary triggers.
	path := filepath.Join(dir, "doc.pdf")
	if err := os.WriteFile(path, append([]byte("%PDF-1.4\n"), 0), 0600); err != nil {
		t.Fatal(err)
	}
	tool := &tools.ReadTool{CWD: dir, Convert: nil}
	raw, _ := json.Marshal(map[string]any{"path": path})
	_, err := tool.Execute(context.Background(), raw, nil)
	if err == nil || !strings.Contains(err.Error(), "looks binary") {
		t.Fatalf("want binary refusal without browser, got: %v", err)
	}
}

func TestReadUsesBrowserConvert(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "doc.pdf")
	if err := os.WriteFile(path, append([]byte("%PDF-1.4\n"), 0), 0600); err != nil {
		t.Fatal(err)
	}
	tool := &tools.ReadTool{CWD: dir, Convert: func(ctx context.Context, filename, b64data string) (string, error) {
		if filename != "doc.pdf" {
			t.Fatalf("wrong filename: %s", filename)
		}
		return "# Converted\nhello world", nil
	}}
	raw, _ := json.Marshal(map[string]any{"path": path})
	res, err := tool.Execute(context.Background(), raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	text := res.Content[0].(provider.TextBlock).Text
	if !strings.Contains(text, "hello world") {
		t.Fatalf("converted text missing: %q", text)
	}
}
