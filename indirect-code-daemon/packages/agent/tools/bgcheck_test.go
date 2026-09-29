package tools

import (
	"context"
	"encoding/json"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/core"
)

type fakeBgCheckHost struct {
	res BgCheckResult
	err error
}

func (h fakeBgCheckHost) ReadBackgroundTask(callerSessionID, jobID string, offset, limit int) (BgCheckResult, error) {
	return h.res, h.err
}

func bgCheck(t *testing.T, tool *BgCheckTool, args string) core.ToolResult {
	t.Helper()
	res, err := tool.Execute(context.Background(), json.RawMessage(args), nil)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestBgCheckTailDefault(t *testing.T) {
	tool := &BgCheckTool{Host: fakeBgCheckHost{res: BgCheckResult{
		Found: true, Kind: "bash", Label: "sleep 15", Status: "running",
		Text: "out1\nout2", From: 91, To: 92, Total: 92,
	}}, SessionID: "s"}
	res := bgCheck(t, tool, `{"job_id":"bg_1"}`)
	if got := envAttr(res, "status"); got != "running" {
		t.Fatalf("status attr = %q", got)
	}
	if got := envAttr(res, "command"); got != "sleep 15" {
		t.Fatalf("command attr = %q", got)
	}
	if got := envAttr(res, "page"); got != "91-92/92" {
		t.Fatalf("page attr = %q", got)
	}
	if got := envBody(t, res); got != "91:out1\n92:out2" {
		t.Fatalf("body = %q", got)
	}
}

func TestBgCheckTruncationAndTerminal(t *testing.T) {
	tool := &BgCheckTool{Host: fakeBgCheckHost{res: BgCheckResult{
		Found: true, Kind: "python", Label: "train.py", Status: "done", ExitCode: 0,
		Text: "last", From: 1000, To: 1000, Total: 1000, Dropped: 999, Truncated: true,
	}}, SessionID: "s"}
	res := bgCheck(t, tool, `{"job_id":"bg_2","offset":1000,"limit":10}`)
	if got := envAttr(res, "dropped"); got != "999" {
		t.Fatalf("dropped attr = %q", got)
	}
	if got := envAttr(res, "exit"); got != "0" {
		t.Fatalf("exit attr = %q", got)
	}
	if got := envAttr(res, "status"); got != "done" {
		t.Fatalf("status attr = %q", got)
	}
	if got := envBody(t, res); got != "1000:last" {
		t.Fatalf("body = %q", got)
	}
}

func TestBgCheckNoOutputYet(t *testing.T) {
	tool := &BgCheckTool{Host: fakeBgCheckHost{res: BgCheckResult{
		Found: true, Kind: "bash", Label: "sleep 5", Status: "running",
	}}, SessionID: "s"}
	res := bgCheck(t, tool, `{"job_id":"bg_3"}`)
	if got := envAttr(res, "info"); got != "No output yet." {
		t.Fatalf("info attr = %q", got)
	}
	if got := envBody(t, res); got != "" {
		t.Fatalf("body must be empty, got %q", got)
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
