package tools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

type fakeBgCheckHost struct {
	res BgCheckResult
	err error
}

func (h fakeBgCheckHost) ReadBackgroundTask(callerSessionID, jobID string, offset, limit int) (BgCheckResult, error) {
	return h.res, h.err
}

func bgCheckText(t *testing.T, tool *BgCheckTool, args string) string {
	t.Helper()
	res, err := tool.Execute(context.Background(), json.RawMessage(args), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Content) != 1 {
		t.Fatalf("expected one text block, got %+v", res.Content)
	}
	tb, ok := res.Content[0].(provider.TextBlock)
	if !ok {
		t.Fatalf("expected TextBlock, got %T", res.Content[0])
	}
	return tb.Text
}

func TestBgCheckTailDefault(t *testing.T) {
	tool := &BgCheckTool{Host: fakeBgCheckHost{res: BgCheckResult{
		Found: true, Kind: "bash", Label: "sleep 15", Status: "running",
		Text: "out1\nout2", From: 91, To: 92, Total: 92,
	}}, SessionID: "s"}
	text := bgCheckText(t, tool, `{"job_id":"bg_1"}`)
	if !strings.Contains(text, "Background Task (bash) — running") {
		t.Fatalf("header: %q", text)
	}
	if !strings.Contains(text, "Lines 91–92 of 92") {
		t.Fatalf("range: %q", text)
	}
	if !strings.Contains(text, "91:out1\n92:out2") {
		t.Fatalf("numbered lines: %q", text)
	}
	if !strings.Contains(text, "still running") {
		t.Fatalf("status: %q", text)
	}
}

func TestBgCheckTruncationAndTerminal(t *testing.T) {
	tool := &BgCheckTool{Host: fakeBgCheckHost{res: BgCheckResult{
		Found: true, Kind: "python", Label: "train.py", Status: "done", ExitCode: 0,
		Text: "last", From: 1000, To: 1000, Total: 1000, Dropped: 999, Truncated: true,
	}}, SessionID: "s"}
	text := bgCheckText(t, tool, `{"job_id":"bg_2","offset":1000,"limit":10}`)
	if !strings.Contains(text, "999 earlier lines discarded") {
		t.Fatalf("dropped: %q", text)
	}
	if !strings.Contains(text, "Status: done (exit 0).") {
		t.Fatalf("terminal: %q", text)
	}
}

func TestBgCheckRequiresJobID(t *testing.T) {
	tool := &BgCheckTool{Host: fakeBgCheckHost{}, SessionID: "s"}
	if _, err := tool.Execute(context.Background(), json.RawMessage(`{}`), nil); err == nil {
		t.Fatal("empty job_id must fail")
	}
	toolNoHost := &BgCheckTool{SessionID: "s"}
	if _, err := toolNoHost.Execute(context.Background(), json.RawMessage(`{"job_id":"bg_1"}`), nil); err == nil {
		t.Fatal("nil host must fail")
	}
	toolUnknown := &BgCheckTool{Host: fakeBgCheckHost{res: BgCheckResult{Found: false}}, SessionID: "s"}
	if _, err := toolUnknown.Execute(context.Background(), json.RawMessage(`{"job_id":"bg_nope"}`), nil); err == nil {
		t.Fatal("unknown task must fail")
	}
}
