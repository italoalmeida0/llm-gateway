package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---- slice coercion: models emit lone values where arrays are expected ----

func TestUnmarshalArgsWrapsLoneSliceValues(t *testing.T) {
	var sa SearchArgs
	if err := unmarshalArgs(json.RawMessage(`{"pattern":"x","include":"*.ts","exclude":"dist/**"}`), &sa); err != nil {
		t.Fatalf("string include/exclude must be accepted: %v", err)
	}
	if len(sa.Include) != 1 || sa.Include[0] != "*.ts" || len(sa.Exclude) != 1 || sa.Exclude[0] != "dist/**" {
		t.Fatalf("got include=%v exclude=%v", sa.Include, sa.Exclude)
	}

	if err := unmarshalArgs(json.RawMessage(`{"pattern":"x","include":"[\"*.ts\",\"*.tsx\"]"}`), &sa); err != nil {
		t.Fatalf("JSON-in-string include must be accepted: %v", err)
	}
	if len(sa.Include) != 2 || sa.Include[1] != "*.tsx" {
		t.Fatalf("got include=%v", sa.Include)
	}

	if err := unmarshalArgs(json.RawMessage(`{"pattern":"x","include":["*.go"]}`), &sa); err != nil {
		t.Fatalf("plain array must still work: %v", err)
	}
	if len(sa.Include) != 1 || sa.Include[0] != "*.go" {
		t.Fatalf("got include=%v", sa.Include)
	}
}

func TestUnmarshalArgsWrapsSingleEditObject(t *testing.T) {
	var ea editArgs
	if err := unmarshalArgs(json.RawMessage(`{"path":"a.txt","edits":{"old_text":"a","new_text":"b"}}`), &ea); err != nil {
		t.Fatalf("single edit object must be accepted: %v", err)
	}
	if len(ea.Edits) != 1 || ea.Edits[0].OldText != "a" || ea.Edits[0].NewText != "b" {
		t.Fatalf("got %+v", ea.Edits)
	}

	var qa QuestionRequest
	if err := unmarshalArgs(json.RawMessage(`{"questions":{"header":"H","question":"Q?","options":[{"label":"A"}]}}`), &qa); err != nil {
		t.Fatalf("single question object must be accepted: %v", err)
	}
	if len(qa.Questions) != 1 || qa.Questions[0].Header != "H" {
		t.Fatalf("got %+v", qa.Questions)
	}
}

// ---- edit: indentation-tolerant matching and nearest-match hints ----

func TestEditIndentTolerantBlock(t *testing.T) {
	dir := t.TempDir()
	content := "func f() {\n\t\tif x {\n\t\t\treturn 1\n\t\t}\n\t}\n"
	writeFileForTest(t, dir, "a.go", content)
	tool := &EditTool{CWD: dir}
	// old_text written at 0/1-tab indentation while the file uses 2/3 tabs.
	res, err := tool.Execute(context.Background(), json.RawMessage(
		`{"path":"a.go","edits":[{"old_text":"if x {\n\treturn 1\n}","new_text":"if y {\n\treturn 2\n}"}]}`), nil)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.IsError {
		t.Fatalf("tool error: %v", res.Content)
	}
	got := readFileForTest(t, dir, "a.go")
	want := "func f() {\n\t\tif y {\n\t\t\treturn 2\n\t\t}\n\t}\n"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestEditIndentTolerantKeepsTrailingNewline(t *testing.T) {
	dir := t.TempDir()
	writeFileForTest(t, dir, "a.txt", "  keep\n  drop\n  keep2\n")
	tool := &EditTool{CWD: dir}
	// old_text ends with a newline: the span must include the line ending
	// so the replacement does not merge lines.
	res, err := tool.Execute(context.Background(), json.RawMessage(
		`{"path":"a.txt","edits":[{"old_text":"drop\n","new_text":"new\n"}]}`), nil)
	if err != nil || res.IsError {
		t.Fatalf("Execute: %v %v", err, res.Content)
	}
	if got := readFileForTest(t, dir, "a.txt"); got != "  keep\n  new\n  keep2\n" {
		t.Fatalf("got %q", got)
	}
}

func TestEditIndentTolerantDuplicate(t *testing.T) {
	dir := t.TempDir()
	writeFileForTest(t, dir, "a.txt", "  x := 1\n  y := 2\n\t\tx := 1\n")
	tool := &EditTool{CWD: dir}
	_, err := tool.Execute(context.Background(), json.RawMessage(
		`{"path":"a.txt","edits":[{"old_text":"x := 1","new_text":"x := 3"}]}`), nil)
	if err == nil || !strings.Contains(err.Error(), "occurrences") {
		t.Fatalf("want duplicate error, got %v", err)
	}
}

func TestEditNotFoundHintShowsClosestLine(t *testing.T) {
	dir := t.TempDir()
	writeFileForTest(t, dir, "a.txt", "alpha\nbeta value = 1\ngamma\n")
	tool := &EditTool{CWD: dir}
	_, err := tool.Execute(context.Background(), json.RawMessage(
		`{"path":"a.txt","edits":[{"old_text":"beta value = 2","new_text":"x"}]}`), nil)
	if err == nil {
		t.Fatal("expected not-found error")
	}
	msg := err.Error()
	if !strings.Contains(msg, "Could not find the exact text in a.txt.") {
		t.Fatalf("base message lost: %q", msg)
	}
	if !strings.Contains(msg, "beta value = 1") || !strings.Contains(msg, "line 2") {
		t.Fatalf("hint must quote the closest line with its number: %q", msg)
	}
}

// ---- bg_check/bg_cancel: hallucinated job ids ----

type recordingBgCheckHost struct {
	called bool
	res    BgCheckResult
}

func (h *recordingBgCheckHost) ReadBackgroundTask(string, string, int, int) (BgCheckResult, error) {
	h.called = true
	return h.res, nil
}

func TestBgCheckRejectsHallucinatedJobID(t *testing.T) {
	host := &recordingBgCheckHost{res: BgCheckResult{Found: true}}
	tool := &BgCheckTool{Host: host, SessionID: "s"}
	_, err := tool.Execute(context.Background(), json.RawMessage(`{"job_id":"poll session_id=75711"}`), nil)
	if err == nil {
		t.Fatal("hallucinated job_id must fail")
	}
	if !strings.Contains(err.Error(), "not a valid job_id") || !strings.Contains(err.Error(), "placeholder") {
		t.Fatalf("error must explain where the id comes from: %v", err)
	}
	if host.called {
		t.Fatal("host must not be queried with a malformed job_id")
	}
	// Real id shapes pass the format check: current short halves, legacy
	// 64-hex halves and the bg_ stub ids.
	for _, id := range []string{
		"1a2b3c4d5e6f7a8b_9f8e7d6c5b4a3210",
		"3ae6e781d265ae75a3c73ab7e3ffccefc449d45f6520ad8e7617d85bd2c67385_178c116d59b6363fcb81180381955834535681302770085e4bb27e3cec01551b",
		"bg_1a2b3c4d5e6f7a8b",
	} {
		if err := checkBgJobID("bg_check", id); err != nil {
			t.Fatalf("valid id %q rejected: %v", id, err)
		}
	}
}

// ---- question: label matching is tolerant to case/whitespace ----

func TestQuestionValidateAnswersFoldsLabels(t *testing.T) {
	req := QuestionRequest{Questions: []Question{{
		Header: "Q", Question: "Q?",
		Options:    []QuestionOption{{Label: "First (Recommended)"}, {Label: "Second"}},
		DecideLater: true,
	}}}
	answers := [][]string{{"  first (recommended) "}}
	if err := req.ValidateAnswers(answers); err != nil {
		t.Fatalf("tolerant label must be accepted: %v", err)
	}
	if answers[0][0] != "First (Recommended)" {
		t.Fatalf("answer must be canonicalized, got %q", answers[0][0])
	}
	if err := req.ValidateAnswers([][]string{{"decide later (do whatever you think is best)"}}); err != nil {
		t.Fatalf("decide-later must match case-insensitively: %v", err)
	}
	reqMulti := QuestionRequest{Questions: []Question{{
		Header: "Q", Question: "Q?", Multiple: true,
		Options: []QuestionOption{{Label: "A"}},
	}}}
	if err := reqMulti.ValidateAnswers([][]string{{"nope", "another one"}}); err == nil {
		t.Fatal("two custom answers must fail")
	}
}

// ---- helpers ----

func writeFileForTest(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFileForTest(t *testing.T, dir, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
