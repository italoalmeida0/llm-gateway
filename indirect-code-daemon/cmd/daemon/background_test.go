package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

func testBgServer(t *testing.T) *DaemonServer {
	t.Helper()
	dir := t.TempDir()
	d := &DaemonServer{
		sessions: map[string]*ActiveSession{},
		bgJobs:   map[string]*BgJob{},
		config:   &DaemonConfig{HostID: "test-host"},
		dataDir:  dir,
	}
	return d
}

func mkSession(t *testing.T, d *DaemonServer, id, mode string) {
	t.Helper()
	now := time.Now().UnixMilli()
	rec := &SessionRecord{
		Options:   normalizedOptions(SessionOptions{Mode: mode}),
		ID:        id,
		CWD:       t.TempDir(),
		Title:     "parent",
		Model:     "m",
		Status:    "idle",
		CreatedAt: now, UpdatedAt: now,
	}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	if _, err := d.getOrCreateActiveSession(id); err != nil {
		t.Fatal(err)
	}
}

// cancelText runs the bg_cancel tool and returns its model-facing text.
func cancelText(t *testing.T, d *DaemonServer, caller, args string) (string, error) {
	t.Helper()
	tool := &tools.BgCancelTool{Host: d, SessionID: caller}
	res, err := tool.Execute(context.Background(), []byte(args), nil)
	if err != nil {
		return "", err
	}
	var sb strings.Builder
	for _, c := range res.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			sb.WriteString(tb.Text)
		}
	}
	return sb.String(), nil
}

func TestBashAutoBackground(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix shell only")
	}
	old := tools.AutoBackgroundAfter
	tools.AutoBackgroundAfter = 50 * time.Millisecond
	defer func() { tools.AutoBackgroundAfter = old }()
	d := testBgServer(t)
	mkSession(t, d, "sess_parent", "build")
	// Drain the wake-up turn: the job finishes after the test's last
	// assertion and must not write into a removed TempDir.
	wakeups := make(chan string, 10)
	d.runTurnHook = func(act *ActiveSession, prompt string) { wakeups <- prompt }
	bash := &tools.BashTool{CWD: t.TempDir(), Sandbox: tools.NewSandbox(t.TempDir()), Slow: d.slowHook("sess_parent")}
	res, err := bash.Execute(context.Background(), []byte(`{"command":"echo hi; sleep 5"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	text := ""
	for _, c := range res.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			text = tb.Text
		}
	}
	if !strings.Contains(text, "moved to background") {
		t.Fatalf("expected background placeholder, got %q", text)
	}
	var jobID, logPath string
	if m, ok := res.Details.(map[string]any); ok {
		jobID, _ = m["background_job_id"].(string)
		logPath, _ = m["log_path"].(string)
	}
	if jobID == "" || logPath == "" {
		t.Fatalf("expected job id and log path, got %q / %q", jobID, logPath)
	}
	j := d.bgGet(jobID)
	if j == nil || j.Status != BgStatusRunning {
		t.Fatalf("job must be running, got %+v", j)
	}
	select {
	case <-j.done:
	case <-time.After(10 * time.Second):
		t.Fatal("job never finished")
	}
	if j.Status != BgStatusDone || !strings.Contains(j.Result, "hi") {
		t.Fatalf("expected done with output, got %+v", j)
	}
	select {
	case <-wakeups:
	case <-time.After(5 * time.Second):
		t.Fatal("wake-up never arrived")
	}
}

func TestSlowHookDeliveryIsSystemReminder(t *testing.T) {
	d := testBgServer(t)
	mkSession(t, d, "sess_parent", "build")
	wakeups := make(chan string, 10)
	d.runTurnHook = func(act *ActiveSession, prompt string) { wakeups <- prompt }
	hook := d.slowHook("sess_parent")
	id, logPath, _, deliver := hook("bash", "sleep 1", nil)
	j := d.bgGet(id)
	if j == nil || j.Status != BgStatusRunning {
		t.Fatal("job must be running")
	}
	if logPath == "" || !strings.HasSuffix(logPath, ".log") {
		t.Fatalf("expected brain .log path, got %q", logPath)
	}
	deliver("secret-output", false)
	if j.Status != BgStatusDone {
		t.Fatalf("expected done, got %q", j.Status)
	}
	select {
	case w := <-wakeups:
		if !strings.Contains(w, "<system-reminder>") {
			t.Fatalf("delivery must be a system-reminder, got %q", w)
		}
		if strings.Contains(w, "secret-output") {
			t.Fatalf("delivery must NOT carry the result, got %q", w)
		}
		if !strings.Contains(w, logPath) {
			t.Fatalf("delivery must name the .log path, got %q", w)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("wake-up turn never started")
	}
}

func TestBgLogStreamsAndSurvives(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix shell only")
	}
	old := tools.AutoBackgroundAfter
	tools.AutoBackgroundAfter = 50 * time.Millisecond
	defer func() { tools.AutoBackgroundAfter = old }()
	d := testBgServer(t)
	mkSession(t, d, "sess_parent", "build")
	bash := &tools.BashTool{CWD: t.TempDir(), Sandbox: tools.NewSandbox(t.TempDir()), Slow: d.slowHook("sess_parent")}
	res, err := bash.Execute(context.Background(), []byte(`{"command":"echo early-out; sleep 30"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	text := ""
	var jobID, logPath string
	for _, c := range res.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			text += tb.Text
		}
	}
	if m, ok := res.Details.(map[string]any); ok {
		jobID, _ = m["background_job_id"].(string)
		logPath, _ = m["log_path"].(string)
	}
	if jobID == "" || logPath == "" {
		t.Fatalf("expected job id and log path, got %q / %q", jobID, logPath)
	}
	if !strings.Contains(text, logPath) {
		t.Fatalf("placeholder must name the .log path, got %q", text)
	}
	if !strings.Contains(text, "bg_cancel") || !strings.Contains(text, "sleep") {
		t.Fatalf("placeholder must teach bg_cancel + sleep, got %q", text)
	}
	// The pre-detach output is flushed into the file right away.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(logPath); err == nil && strings.Contains(string(data), "early-out") {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if data, err := os.ReadFile(logPath); err != nil || !strings.Contains(string(data), "early-out") {
		t.Fatalf("log must contain the pre-detach output, got %q (%v)", string(data), err)
	}
	// Cancel: the process dies, the log file is NOT deleted, nothing is
	// delivered.
	if _, err := cancelText(t, d, "sess_parent", `{"job_id":"`+jobID+`"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(logPath); err != nil {
		t.Fatalf("log file must survive the cancel: %v", err)
	}
	j := d.bgGet(jobID)
	if j.Status != BgStatusCancelled {
		t.Fatalf("expected cancelled, got %q", j.Status)
	}
	// Foreign sessions see nothing in the card snapshot.
	for _, v := range d.bgSnapshot() {
		if v["sessionId"] == "sess_other" {
			t.Fatalf("foreign session must not see the job: %+v", v)
		}
	}
}

func TestBgCancelOwnRunningJob(t *testing.T) {
	d := testBgServer(t)
	mkSession(t, d, "sess_parent", "build")
	hook := d.slowHook("sess_parent")
	id, _, _, deliver := hook("bash", "sleep 30", nil)
	out, err := cancelText(t, d, "sess_parent", `{"job_id":"`+id+`"}`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "cancelled") || !strings.Contains(out, "NOT be delivered") {
		t.Fatalf("expected cancel notice, got %q", out)
	}
	j := d.bgGet(id)
	if j.Status != BgStatusCancelled {
		t.Fatalf("expected cancelled, got %q", j.Status)
	}
	select {
	case <-j.done:
	case <-time.After(5 * time.Second):
		t.Fatal("job done never closed after cancel")
	}
	// The deliver path must be a no-op after cancellation: no status
	// change, no wake-up turn, and the cancellation marker (not the late
	// output) stays as the folded result.
	deliver("late output", false)
	if j.Status != BgStatusCancelled {
		t.Fatalf("cancelled job must stay cancelled, got %q", j.Status)
	}
	if !strings.Contains(j.Result, "cancelled by assistant") || strings.Contains(j.Result, "late output") {
		t.Fatalf("late finish must not overwrite the cancellation marker, got %q", j.Result)
	}
}

func TestBgCancelForeignAndUnknownDenied(t *testing.T) {
	d := testBgServer(t)
	mkSession(t, d, "sess_a", "build")
	mkSession(t, d, "sess_b", "build")
	hook := d.slowHook("sess_a")
	id, _, _, _ := hook("bash", "sleep 30", nil)
	if _, err := cancelText(t, d, "sess_b", `{"job_id":"`+id+`"}`); err == nil || !strings.Contains(err.Error(), "no background task") {
		t.Fatalf("expected foreign denial, got %v", err)
	}
	if _, err := cancelText(t, d, "sess_a", `{"job_id":"bg_typo"}`); err == nil || !strings.Contains(err.Error(), "no background task") {
		t.Fatalf("expected unknown-id denial, got %v", err)
	}
	// The foreign/unknown attempts must not touch the running job.
	if j := d.bgGet(id); j.Status != BgStatusRunning {
		t.Fatalf("job must stay running, got %q", j.Status)
	}
	if !d.bgCancelJob(id, "") {
		t.Fatal("cancel after denials must still work")
	}
}

func TestBgCancelFinishedJobIsNoop(t *testing.T) {
	d := testBgServer(t)
	mkSession(t, d, "sess_parent", "build")
	wakeups := make(chan string, 10)
	d.runTurnHook = func(act *ActiveSession, prompt string) { wakeups <- prompt }
	hook := d.slowHook("sess_parent")
	id, _, _, deliver := hook("bash", "sleep 1", nil)
	deliver("out", false)
	select {
	case <-wakeups:
	case <-time.After(5 * time.Second):
		t.Fatal("wake-up never arrived")
	}
	out, err := cancelText(t, d, "sess_parent", `{"job_id":"`+id+`"}`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "already finished") {
		t.Fatalf("expected already-finished notice, got %q", out)
	}
	if j := d.bgGet(id); j.Status != BgStatusDone {
		t.Fatalf("done job must stay done, got %q", j.Status)
	}
}

// TestBgCancelKillsDetachedBash pins the real fix: cancelling a detached
// bash job kills the whole process group — the sleep actually dies instead
// of running to completion as an orphan.
func TestBgCancelKillsDetachedBash(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix shell only")
	}
	if _, err := exec.LookPath("pgrep"); err != nil {
		t.Skip("pgrep not available")
	}
	d := testBgServer(t)
	mkSession(t, d, "sess_parent", "build")
	old := tools.AutoBackgroundAfter
	tools.AutoBackgroundAfter = 50 * time.Millisecond
	defer func() { tools.AutoBackgroundAfter = old }()
	bash := &tools.BashTool{CWD: t.TempDir(), Sandbox: tools.NewSandbox(t.TempDir()), Slow: d.slowHook("sess_parent")}
	res, err := bash.Execute(context.Background(), []byte(`{"command":"sleep 30"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	var jobID string
	if m, ok := res.Details.(map[string]any); ok {
		jobID, _ = m["background_job_id"].(string)
	}
	if jobID == "" {
		t.Fatal("expected background_job_id in details")
	}
	j := d.bgGet(jobID)
	if j == nil || j.Status != BgStatusRunning {
		t.Fatalf("job must be running, got %+v", j)
	}
	alive := func() bool {
		out, err := exec.Command("pgrep", "-f", "sleep 30").Output()
		return err == nil && len(strings.TrimSpace(string(out))) > 0
	}
	if !alive() {
		t.Fatal("detached sleep must be alive before cancel")
	}
	if _, err := cancelText(t, d, "sess_parent", `{"job_id":"`+jobID+`"}`); err != nil {
		t.Fatal(err)
	}
	if j.Status != BgStatusCancelled {
		t.Fatalf("expected cancelled, got %q", j.Status)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !alive() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("detached sleep survived bg_cancel — process group was not killed")
}

// TestManualCancelNotifiesOwner pins the dashboard-stop contract: a manual
// stop attributes the cancel in the .log ("user"), folds a truthful
// terminal marker into the row, and delivers a cancellation notice so the
// AI learns the task is gone (the model's own bg_cancel stays silent —
// its caller learns from the tool result).
func TestManualCancelNotifiesOwner(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix shell only")
	}
	old := tools.AutoBackgroundAfter
	tools.AutoBackgroundAfter = 50 * time.Millisecond
	defer func() { tools.AutoBackgroundAfter = old }()
	d := testBgServer(t)
	mkSession(t, d, "sess_parent", "build")
	wakeups := make(chan string, 10)
	d.runTurnHook = func(act *ActiveSession, prompt string) { wakeups <- prompt }
	bash := &tools.BashTool{CWD: t.TempDir(), Sandbox: tools.NewSandbox(t.TempDir()), Slow: d.slowHook("sess_parent")}
	res, err := bash.Execute(context.Background(), []byte(`{"command":"sleep 30"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	var jobID, logPath string
	if m, ok := res.Details.(map[string]any); ok {
		jobID, _ = m["background_job_id"].(string)
		logPath, _ = m["log_path"].(string)
	}
	if jobID == "" || logPath == "" {
		t.Fatal("expected background_job_id and log_path in details")
	}
	// The wire snapshot carries the owner session (the card + the fold
	// scope rows by it).
	found := false
	for _, p := range d.bgSnapshot() {
		if p["id"] == jobID {
			found = true
			if p["sessionId"] != "sess_parent" {
				t.Fatalf("snapshot must carry the owner session, got %v", p["sessionId"])
			}
		}
	}
	if !found {
		t.Fatal("detached job missing from snapshot")
	}
	d.handleBgCancel([]byte(`{"jobId":"` + jobID + `"}`))
	j := d.bgGet(jobID)
	if j.Status != BgStatusCancelled {
		t.Fatalf("expected cancelled, got %q", j.Status)
	}
	if !strings.Contains(j.Result, "cancelled by user") {
		t.Fatalf("folded row must name the cancellation, got %q", j.Result)
	}
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "[cancelled by user]") {
		t.Fatalf(".log must record the manual stop, got %q", string(raw))
	}
	select {
	case prompt := <-wakeups:
		if !strings.Contains(prompt, "cancelled by the user") {
			t.Fatalf("cancel notice must explain the stop, got %q", prompt)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("manual cancel delivered no notice — the AI would keep waiting")
	}
}

// TestToolCancelStaysSilent pins the bg_cancel tool contract: the model
// learns from the tool result (no wake-up notice), while the stop is
// still attributed in the .log ("assistant") and the folded row.
func TestToolCancelStaysSilent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix shell only")
	}
	old := tools.AutoBackgroundAfter
	tools.AutoBackgroundAfter = 50 * time.Millisecond
	defer func() { tools.AutoBackgroundAfter = old }()
	d := testBgServer(t)
	mkSession(t, d, "sess_parent", "build")
	wakeups := make(chan string, 10)
	d.runTurnHook = func(act *ActiveSession, prompt string) { wakeups <- prompt }
	bash := &tools.BashTool{CWD: t.TempDir(), Sandbox: tools.NewSandbox(t.TempDir()), Slow: d.slowHook("sess_parent")}
	res, err := bash.Execute(context.Background(), []byte(`{"command":"sleep 30"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	var jobID, logPath string
	if m, ok := res.Details.(map[string]any); ok {
		jobID, _ = m["background_job_id"].(string)
		logPath, _ = m["log_path"].(string)
	}
	if jobID == "" || logPath == "" {
		t.Fatal("expected background_job_id and log_path in details")
	}
	out, err := cancelText(t, d, "sess_parent", `{"job_id":"`+jobID+`"}`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "cancelled") {
		t.Fatalf("expected cancellation outcome, got %q", out)
	}
	if j := d.bgGet(jobID); j.Status != BgStatusCancelled {
		t.Fatalf("expected cancelled, got %q", j.Status)
	}
	raw, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "[cancelled by assistant]") {
		t.Fatalf(".log must record the tool stop, got %q", string(raw))
	}
	if j := d.bgGet(jobID); !strings.Contains(j.Result, "cancelled by assistant") {
		t.Fatalf("folded row must name the cancellation, got %q", j.Result)
	}
	select {
	case prompt := <-wakeups:
		t.Fatalf("tool cancel must not wake the session, got %q", prompt)
	case <-time.After(500 * time.Millisecond):
	}
}

// bgHistory builds a transcript with one detached bash placeholder.
func bgHistory(callID string, details map[string]any) []provider.Message {
	return []provider.Message{
		{Role: provider.RoleUser, TurnIndex: 5, Content: []provider.Content{
			provider.TextBlock{Text: "run it"},
		}},
		{Role: provider.RoleAssistant, TurnIndex: 5, Content: []provider.Content{
			provider.ToolCallBlock{ID: callID, Name: "bash", Arguments: json.RawMessage(`{"command":"sleep 60"}`)},
		}},
		{Role: provider.RoleTool, TurnIndex: 5, Content: []provider.Content{
			provider.ToolResultBlock{CallID: callID, StartedAt: 1, DurationMs: 10009,
				Content: []provider.Content{provider.TextBlock{Text: "Command moved to background (still running)."}},
				Details: details},
		}},
	}
}

func bgDetails(jobID string) map[string]any {
	return map[string]any{"background_job_id": jobID, "log_path": "/tmp/orphan.log"}
}

// hydrateRoundTrip mirrors production: saveSession/loadSession decodes
// tool details into json.RawMessage, NOT map[string]any. A scan tested
// only on in-memory structs passes while finding nothing on every real
// restart — hydrate before scanning.
func hydrateRoundTrip(t *testing.T, msgs []provider.Message) []provider.Message {
	t.Helper()
	out := make([]provider.Message, 0, len(msgs))
	for _, m := range msgs {
		raw, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		hm, err := core.HydrateMessageObject(raw)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, hm)
	}
	return out
}

// TestFindRestartOrphans pins the boot-scan decision: a detached
// placeholder with no live job and no delivery behind it reports once,
// with the label rebuilt from the call; delivered, live, tool-cancelled
// and plain results never report.
func TestFindRestartOrphans(t *testing.T) {
	// Both detail shapes: hydrated (the only shape a restart ever sees)
	// and in-memory maps.
	if bgDetailString(map[string]any{"k": "v"}, "k") != "v" ||
		bgDetailString(json.RawMessage(`{"k":"v"}`), "k") != "v" {
		t.Fatal("bgDetailString must read map and raw-JSON details")
	}
	hist := hydrateRoundTrip(t, bgHistory("c1", bgDetails("bg_9")))
	orphans := findRestartOrphans(hist, map[string]bool{})
	if len(orphans) != 1 {
		t.Fatalf("uninformed orphan must report, got %+v", orphans)
	}
	o := orphans[0]
	if o.id != "bg_9" || o.kind != "bash" || o.label != "sleep 60" || o.logPath != "/tmp/orphan.log" {
		t.Fatalf("wrong orphan fields: %+v", o)
	}
	if !strings.Contains(bgRestartNotice(o), "lost in the daemon restart") || !strings.Contains(bgRestartNotice(o), "/tmp/orphan.log") {
		t.Fatalf("notice must explain the restart and point at the log: %q", bgRestartNotice(o))
	}
	// A delivered completion notice informs: no report.
	delivered := append(append([]provider.Message{}, hist...), hydrateRoundTrip(t, []provider.Message{{
		Role: provider.RoleUser, Content: []provider.Content{provider.TextBlock{Text: "<system-reminder/>"}},
		Meta: map[string]string{"background_delivery": "bg_9", "background_kind": "bash"},
	}})...)
	if out := findRestartOrphans(delivered, map[string]bool{}); len(out) != 0 {
		t.Fatalf("delivered job must not report: %+v", out)
	}
	// A live registry entry is not an orphan.
	if out := findRestartOrphans(hist, map[string]bool{"bg_9": true}); len(out) != 0 {
		t.Fatalf("live job must not report: %+v", out)
	}
	// A bg_cancel close (cancelled:true details) informed the model
	// through that tool call — no restart notice needed.
	cancelled := hydrateRoundTrip(t, bgHistory("c1", map[string]any{"background_job_id": "bg_9", "cancelled": true, "status": "cancelled"}))
	if out := findRestartOrphans(cancelled, map[string]bool{}); len(out) != 0 {
		t.Fatalf("tool-cancelled job must not report: %+v", out)
	}
	// Plain results and duplicates never report.
	plain := hydrateRoundTrip(t, bgHistory("c1", nil))
	if out := findRestartOrphans(plain, map[string]bool{}); len(out) != 0 {
		t.Fatalf("result without job details must not report: %+v", out)
	}
	dup := append(append([]provider.Message{}, hist...), hist[2])
	if out := findRestartOrphans(dup, map[string]bool{}); len(out) != 1 {
		t.Fatalf("duplicate placeholder must report once, got %+v", out)
	}
	// Python labels come from the first meaningful code line.
	pyHist := hydrateRoundTrip(t, []provider.Message{
		{Role: provider.RoleAssistant, TurnIndex: 5, Content: []provider.Content{
			provider.ToolCallBlock{ID: "p1", Name: "python", Arguments: json.RawMessage(`{"code":"# wait\nimport time\ntime.sleep(60)"}`)},
		}},
		{Role: provider.RoleTool, TurnIndex: 5, Content: []provider.Content{
			provider.ToolResultBlock{CallID: "p1", Content: []provider.Content{provider.TextBlock{Text: "moved"}},
				Details: map[string]any{"background_job_id": "bg_py"}},
		}},
	})
	if out := findRestartOrphans(pyHist, map[string]bool{}); len(out) != 1 || out[0].label != "import time" || out[0].kind != "python" {
		t.Fatalf("python orphan mislabeled: %+v", out)
	}
}

// TestResumeInjectsRestartNotice pins the reported gap end to end: a turn
// interrupted while its background task was still running resumes with a
// restart notice in context — the agent learns the task will not report
// back instead of waiting on a dead job id.
func TestResumeInjectsRestartNotice(t *testing.T) {
	d := testDaemon(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/indirect-code/models" {
			fmt.Fprint(w, `{"models":[{"id":"m","limit":{"context":100000,"output":1000}}]}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"m\",\"usage\":{\"input_tokens\":1}}}\n\n")
		fmt.Fprint(w, "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n")
		fmt.Fprint(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Recovered\"}}\n\n")
		fmt.Fprint(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n")
		fmt.Fprint(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer upstream.Close()
	d.config.GatewayURL = upstream.URL
	rec := &SessionRecord{ID: "recover-bg", CWD: t.TempDir(), Model: "m", Status: "idle", TurnSeq: 5,
		Options: SessionOptions{Mode: "talk"}, Turn: &TurnActivity{StartedAt: 123, Status: "running"},
		Messages: bgHistory("c1", bgDetails("bg_9"))}
	d.saveSession(rec)
	// Reload from disk exactly like production startup does: the scan
	// must handle hydrated (raw-JSON) tool details, not just the
	// in-memory map form this test builds above.
	loaded, err := d.loadSession(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	act := &ActiveSession{record: loaded}
	d.sessions[rec.ID] = act
	ww, werr := d.openWAL(rec.ID, &walHeader{TurnIndex: 5, StartedAt: 123, Prompt: "original"})
	if werr != nil {
		t.Fatal(werr)
	}
	act.wal = ww
	d.resumeAgentTurn(act, &walHeader{TurnIndex: 5, StartedAt: 123, Prompt: "original"})
	saved, err := d.loadSession(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	notices := 0
	for _, m := range saved.Messages {
		if m.Meta["background_delivery"] != "bg_9" {
			continue
		}
		notices++
		text := ""
		for _, c := range m.Content {
			if tb, ok := c.(provider.TextBlock); ok {
				text += tb.Text
			}
		}
		if !strings.Contains(text, "lost in the daemon restart") || !strings.Contains(text, "/tmp/orphan.log") {
			t.Fatalf("restart notice must explain + point at log: %q", text)
		}
	}
	if notices != 1 {
		t.Fatalf("expected exactly one restart notice, got %d", notices)
	}
	if h, _ := d.readWALHeader(rec.ID); h != nil {
		t.Fatal("finished recovery kept WAL")
	}
}

// TestRecentBgFinish pins the staleness source: most recent terminal job
// per session, skipped while anything still runs (the watcher owns that
// wait), empty registry reports nothing.
func TestRecentBgFinish(t *testing.T) {
	d := testBgServer(t)
	now := time.Now().UnixMilli()
	d.bgJobs["old"] = &BgJob{ID: "old", SessionID: "s1", Label: "old cmd", Status: BgStatusDone, EndedAt: now - 300_000}
	d.bgJobs["new"] = &BgJob{ID: "new", SessionID: "s1", Label: "new cmd", Status: BgStatusError, EndedAt: now - 3_000}
	d.bgJobs["run"] = &BgJob{ID: "run", SessionID: "s1", Label: "run cmd", Status: BgStatusRunning}
	d.bgJobs["other"] = &BgJob{ID: "other", SessionID: "s2", Label: "other cmd", Status: BgStatusDone, EndedAt: now - 1_000}
	// A running job vetoes the shortcut even with a fresh finish around.
	if _, _, ok := d.RecentBgFinish("s1"); ok {
		t.Fatal("must not report while a session job still runs")
	}
	delete(d.bgJobs, "run")
	label, ago, ok := d.RecentBgFinish("s1")
	if !ok || label != "new cmd" {
		t.Fatalf("must report the most recent finish, got %q %v %v", label, ago, ok)
	}
	if ago < 2*time.Second || ago > 30*time.Second {
		t.Fatalf("age must track EndedAt, got %s", ago)
	}
	if _, _, ok := d.RecentBgFinish("s2"); !ok {
		t.Fatal("other session must still report its own finish")
	}
	if _, _, ok := d.RecentBgFinish("nobody"); ok {
		t.Fatal("empty registry must report nothing")
	}
}

// TestDetachedBashSurvivesTurnEnd pins the core guarantee: a bash command
// that auto-backgrounds must NOT die when the turn context ends. The
// process hangs off its own context; only an explicit stop kills it.
func TestDetachedBashSurvivesTurnEnd(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix shell only")
	}
	old := tools.AutoBackgroundAfter
	tools.AutoBackgroundAfter = 50 * time.Millisecond
	defer func() { tools.AutoBackgroundAfter = old }()
	d := testBgServer(t)
	mkSession(t, d, "sess_parent", "build")
	wakeups := make(chan string, 10)
	d.runTurnHook = func(act *ActiveSession, prompt string) { wakeups <- prompt }
	bash := &tools.BashTool{CWD: t.TempDir(), Sandbox: tools.NewSandbox(t.TempDir()), Slow: d.slowHook("sess_parent")}
	turnCtx, cancelTurn := context.WithCancel(context.Background())
	type outcome struct {
		res core.ToolResult
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		res, err := bash.Execute(turnCtx, []byte(`{"command":"echo detached-output; sleep 2"}`), nil)
		done <- outcome{res, err}
	}()
	var jobID string
	select {
	case o := <-done:
		if o.err != nil {
			t.Fatal(o.err)
		}
		if m, ok := o.res.Details.(map[string]any); ok {
			jobID, _ = m["background_job_id"].(string)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("placeholder never arrived")
	}
	if jobID == "" {
		t.Fatal("expected background_job_id in details")
	}
	// The turn ends while the job runs: the process must survive it.
	cancelTurn()
	j := d.bgGet(jobID)
	select {
	case <-j.done:
	case <-time.After(10 * time.Second):
		t.Fatal("detached job never finished")
	}
	select {
	case <-wakeups:
	case <-time.After(5 * time.Second):
		t.Fatal("wake-up never arrived")
	}
	if j.Status != BgStatusDone {
		t.Fatalf("detached job must complete despite the turn ending, got %q: %s", j.Status, j.Result)
	}
	if !strings.Contains(j.Result, "detached-output") {
		t.Fatalf("detached job must deliver its real output, got %q", j.Result)
	}
}

// TestDetachedPythonSurvivesExecuteReturn pins the python twin: the script
// must not be cancelled when Execute returns the placeholder.
func TestDetachedPythonSurvivesExecuteReturn(t *testing.T) {
	if _, err := tools.PythonAvailable(); err != nil {
		t.Skipf("no python3 on this machine: %v", err)
	}
	old := tools.AutoBackgroundAfter
	tools.AutoBackgroundAfter = 50 * time.Millisecond
	defer func() { tools.AutoBackgroundAfter = old }()
	d := testBgServer(t)
	mkSession(t, d, "sess_parent", "build")
	wakeups := make(chan string, 10)
	d.runTurnHook = func(act *ActiveSession, prompt string) { wakeups <- prompt }
	py := &tools.PythonTool{CWD: t.TempDir(), Sandbox: tools.NewSandbox(t.TempDir()), Slow: d.slowHook("sess_parent")}
	res, err := py.Execute(context.Background(), []byte(`{"code":"import time; print('py-detached-ok', flush=True); time.sleep(1.5)"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	var jobID string
	if m, ok := res.Details.(map[string]any); ok {
		jobID, _ = m["background_job_id"].(string)
	}
	if jobID == "" {
		t.Fatal("expected background_job_id in details")
	}
	j := d.bgGet(jobID)
	select {
	case <-j.done:
	case <-time.After(10 * time.Second):
		t.Fatal("detached python job never finished")
	}
	select {
	case <-wakeups:
	case <-time.After(5 * time.Second):
		t.Fatal("wake-up never arrived")
	}
	if j.Status != BgStatusDone {
		t.Fatalf("detached python job must complete, got %q: %s", j.Status, j.Result)
	}
	if !strings.Contains(j.Result, "py-detached-ok") {
		t.Fatalf("detached python job must deliver its real output, got %q", j.Result)
	}
}

// TestPythonStreamsToLogAfterDetach pins the fan-out fix: output produced
// AFTER the detach must reach the .log file too — not just the pre-detach
// buffer flush. (Reassigning cmd.Stdout after Start would silently keep
// writing to the old buffers only.)
func TestPythonStreamsToLogAfterDetach(t *testing.T) {
	if _, err := tools.PythonAvailable(); err != nil {
		t.Skipf("no python3 on this machine: %v", err)
	}
	old := tools.AutoBackgroundAfter
	tools.AutoBackgroundAfter = 50 * time.Millisecond
	defer func() { tools.AutoBackgroundAfter = old }()
	d := testBgServer(t)
	mkSession(t, d, "sess_parent", "build")
	wakeups := make(chan string, 10)
	d.runTurnHook = func(act *ActiveSession, prompt string) { wakeups <- prompt }
	py := &tools.PythonTool{CWD: t.TempDir(), Sandbox: tools.NewSandbox(t.TempDir()), Slow: d.slowHook("sess_parent")}
	res, err := py.Execute(context.Background(), []byte(`{"code":"import time; print('line-before', flush=True); time.sleep(2); print('line-after', flush=True)"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	var logPath string
	if m, ok := res.Details.(map[string]any); ok {
		logPath, _ = m["log_path"].(string)
	}
	if logPath == "" {
		t.Fatal("expected log_path in details")
	}
	j := d.bgGet(mustBgID(t, res))
	select {
	case <-j.done:
	case <-time.After(10 * time.Second):
		t.Fatal("detached python job never finished")
	}
	select {
	case <-wakeups:
	case <-time.After(5 * time.Second):
		t.Fatal("wake-up never arrived")
	}
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "line-before") || !strings.Contains(string(data), "line-after") {
		t.Fatalf("log must contain pre- AND post-detach output, got %q", string(data))
	}
}

func mustBgID(t *testing.T, res core.ToolResult) string {
	t.Helper()
	if m, ok := res.Details.(map[string]any); ok {
		if id, _ := m["background_job_id"].(string); id != "" {
			return id
		}
	}
	t.Fatal("expected background_job_id in details")
	return ""
}

// Sleep rows are header-only (live remaining counter in the label), so
// the tool must never emit progress ticks: progress events append
// forever and would pile "29s left28s left…" into the transcript.
func TestSleepEmitsNoProgress(t *testing.T) {
	tool := &tools.SleepTool{}
	if _, err := tool.Execute(context.Background(), []byte(`{"seconds":1}`), func(string) {
		t.Error("sleep must not emit progress ticks")
	}); err != nil {
		t.Fatal(err)
	}
}

func TestSleepWakesOnJobFinish(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix shell only")
	}
	d := testBgServer(t)
	mkSession(t, d, "sess_parent", "build")
	old := tools.AutoBackgroundAfter
	tools.AutoBackgroundAfter = 50 * time.Millisecond
	defer func() { tools.AutoBackgroundAfter = old }()

	// A detached bash job; the sleep tool must wake when it finishes.
	bash := &tools.BashTool{CWD: t.TempDir(), Sandbox: tools.NewSandbox(t.TempDir()), Slow: d.slowHook("sess_parent")}
	go func() {
		_, _ = bash.Execute(context.Background(), []byte(`{"command":"sleep 2; echo done-sleep"}`), nil)
	}()
	// Wait for the job to appear.
	var jobID string
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, v := range d.bgSnapshot() {
			if v["sessionId"] == "sess_parent" && v["status"] == BgStatusRunning {
				jobID, _ = v["id"].(string)
			}
		}
		if jobID != "" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if jobID == "" {
		t.Fatal("background job never appeared")
	}

	sleep := &tools.SleepTool{Host: d, SessionID: "sess_parent"}
	start := time.Now()
	res, err := sleep.Execute(context.Background(), []byte(`{"seconds":30}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("sleep must wake early, took %v", elapsed)
	}
	text := ""
	for _, c := range res.Content {
		if tb, ok := c.(provider.TextBlock); ok {
			text += tb.Text
		}
	}
	if !strings.Contains(text, "Woken early") {
		t.Fatalf("expected early-wake notice, got %q", text)
	}

	// Cancel the job so the test leaves nothing running.
	if _, err := d.CancelBackgroundJob("sess_parent", jobID); err != nil {
		t.Fatal(err)
	}

	// A session with no jobs sleeps the full (short) duration and never
	// wakes early.
	empty := &tools.SleepTool{Host: d, SessionID: "sess_nobody"}
	start = time.Now()
	if _, err := empty.Execute(context.Background(), []byte(`{"seconds":1}`), nil); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed < 900*time.Millisecond {
		t.Fatalf("sleep without jobs must run its course, took %v", elapsed)
	}
}

// TestDeliverIntoRunningTurnNoDeadlock pins the lock discipline: a notice
// delivered into a LIVE turn must not self-deadlock. The delivery runs
// without act.mu; the persistence hook re-acquires it — the reverse order
// (append under act.mu with the loud hook) wedges the session forever.
func TestDeliverIntoRunningTurnNoDeadlock(t *testing.T) {
	d := testBgServer(t)
	mkSession(t, d, "sess_parent", "build")
	act, _ := d.getOrCreateActiveSession("sess_parent")

	// A live turn with the real persistence wiring: OnMessageAppended
	// re-acquires act.mu exactly like turn_run.go does, and
	// OnContextAppended persists + broadcasts the quiet delivery.
	act.mu.Lock()
	act.record.Status = "running"
	act.mu.Unlock()
	agent := core.NewAgent(nil, "m", "", nil)
	broadcast := make(chan provider.Message, 4)
	agent.OnMessageAppended = func(m provider.Message) {
		act.mu.Lock()
		act.record.Messages = append(act.record.Messages, m)
		act.mu.Unlock()
	}
	agent.OnContextAppended = func(m provider.Message) {
		act.mu.Lock()
		act.record.Messages = append(act.record.Messages, m)
		act.mu.Unlock()
		broadcast <- m
	}
	act.mu.Lock()
	act.agent = agent
	act.mu.Unlock()

	j := d.bgRegister(BgKindBash, "sess_parent", "sleep 1")
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		d.bgFinish(j, BgStatusDone, "command output")
	}()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("delivery deadlocked: bgFinish never returned")
	}
	if j.Status != BgStatusDone {
		t.Fatalf("expected done, got %q", j.Status)
	}
	// The notice joined the live transcript (agent history), was persisted
	// through OnContextAppended (record + broadcast), and carries no
	// result text — only the log pointer contract.
	if len(agent.History()) != 1 {
		t.Fatalf("expected the delivery in agent history, got %d", len(agent.History()))
	}
	select {
	case m := <-broadcast:
		if m.Meta["background_delivery"] == "" {
			t.Fatalf("broadcast message missing background_delivery meta: %+v", m.Meta)
		}
		for _, c := range m.Content {
			if tb, ok := c.(provider.TextBlock); ok && strings.Contains(tb.Text, "command output") {
				t.Fatalf("notice must not carry the result, got %q", tb.Text)
			}
		}
	case <-time.After(5 * time.Second):
		t.Fatal("OnContextAppended never fired — delivery would not persist or reach clients")
	}
	act.mu.Lock()
	persisted := len(act.record.Messages)
	status := act.record.Status
	act.mu.Unlock()
	if persisted != 1 {
		t.Fatalf("delivery must persist through OnContextAppended, got %d persisted", persisted)
	}
	if status != "running" {
		t.Fatalf("turn must stay running, got %q", status)
	}
}

func TestPurgeCancelsJobs(t *testing.T) {
	d := testBgServer(t)
	mkSession(t, d, "sess_parent", "build")
	hook := d.slowHook("sess_parent")
	id, _, _, _ := hook("bash", "sleep 30", nil)
	d.purgeSession("sess_parent")
	if j := d.bgGet(id); j.Status != BgStatusCancelled {
		t.Fatalf("purge must cancel running jobs, got %+v", j)
	}
	if _, err := d.loadSession("sess_parent"); err == nil {
		t.Fatal("parent must be gone")
	}
}

func TestTruncateBgLabel(t *testing.T) {
	// Short labels pass through untouched (no forced …).
	if got := truncateBgLabel(""); got != "" {
		t.Fatalf("got %q", got)
	}
	if got := truncateBgLabel("echo hi"); got != "echo hi" {
		t.Fatalf("got %q", got)
	}
	// Exactly 300 chars stays whole.
	exact := strings.Repeat("x", 300)
	if got := truncateBgLabel(exact); got != exact {
		t.Fatalf("exact-length label must not be cut, got len %d", len([]rune(got)))
	}
	// Longer input keeps the first 300 characters + … (rune-safe).
	long := strings.Repeat("é", 250) + strings.Repeat("y", 100)
	got := truncateBgLabel(long)
	if r := []rune(got); len(r) != 301 || !strings.HasSuffix(got, "…") {
		t.Fatalf("bad truncation: len %d suffix %q", len(r), got)
	}
	if !strings.HasPrefix(got, strings.Repeat("é", 250)) {
		t.Fatalf("truncation must keep the head: %q", got)
	}
}

func TestBgRegisterTruncatesLabel(t *testing.T) {
	d := testBgServer(t)
	mkSession(t, d, "sess_parent", "build")
	j := d.bgRegister(BgKindBash, "sess_parent", strings.Repeat("z", 500), nil)
	if r := []rune(j.Label); len(r) != 301 {
		t.Fatalf("registered label must be truncated, got len %d", len(r))
	}
	d.bgCancelJob(j.ID, "")
}

func TestBgReadTail(t *testing.T) {
	f, err := os.CreateTemp("", "bgtail-*.log")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())
	if _, err := f.WriteString("0123456789"); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	if text, trunc := bgReadTail(f.Name(), 64); text != "0123456789" || trunc {
		t.Fatalf("got %q trunc=%v", text, trunc)
	}
	if text, trunc := bgReadTail(f.Name(), 4); text != "6789" || !trunc {
		t.Fatalf("got %q trunc=%v", text, trunc)
	}
	if text, _ := bgReadTail(f.Name()+"-missing", 64); text != "" {
		t.Fatalf("missing file must read empty, got %q", text)
	}
}
