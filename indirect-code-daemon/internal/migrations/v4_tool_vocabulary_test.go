package migrations

import (
	"encoding/json"
	"testing"
)

// oldToolCall renders one persisted tool call block.
func oldToolCall(name, args string) string {
	return `{"role":"assistant","content":[{"name":"` + name + `","id":"tu_1","arguments":` + args + `}]}`
}

// migrateOneMessage runs applyV4's message rewriter over a single message.
func migrateOneMessage(t *testing.T, msg string) (string, bool) {
	t.Helper()
	out, ok := renameMessageToolVocabulary(json.RawMessage(msg))
	if !ok {
		return msg, false
	}
	return string(out), true
}

func TestV4RenameArgsPerTool(t *testing.T) {
	cases := []struct {
		name   string
		msg    string
		want   []string
		absent []string
	}{
		{
			name:   "completion notes fallback collapses",
			msg:    oldToolCall("mark_task_as_complete", `{"notes":"a"}`),
			want:   []string{`"name":"finish_entire_request"`, `"final_message_to_user":"a"`},
			absent: []string{"notes", "mark_task_as_complete"},
		},
		{
			name:   "completion summary fallback collapses",
			msg:    oldToolCall("mark_plan_as_ready_to_execute", `{"summary":"b"}`),
			want:   []string{`"name":"finish_entire_request"`, `"final_message_to_user":"b"`},
			absent: []string{`"summary"`},
		},
		{
			name:   "bg_await summary becomes reason",
			msg:    oldToolCall("sleep", `{"seconds":10,"waitingFor":"bg_1","summary":"c"}`),
			want:   []string{`"name":"bg_await"`, `"max_wait_seconds":10`, `"waiting_for":"bg_1"`, `"reason":"c"`},
			absent: []string{`"summary"`, "waitingFor", `"seconds"`},
		},
		{
			name:   "summary tool keeps its argument",
			msg:    oldToolCall("summary", `{"summary":"progress"}`),
			want:   []string{`"summary":"progress"`, `"name":"summary"`},
			absent: nil,
		},
		{
			name:   "read keeps snake_case list args",
			msg:    oldToolCall("read", `{"showHidden":true,"maxEntries":3}`),
			want:   []string{`"show_hidden":true`, `"max_entries":3`, `"name":"read"`},
			absent: []string{"showHidden", "maxEntries"},
		},
		{
			name:   "python keeps seconds",
			msg:    oldToolCall("python", `{"seconds":5}`),
			want:   []string{`"seconds":5`, `"name":"python"`},
			absent: nil,
		},
		{
			name:   "search snake_case",
			msg:    oldToolCall("search", `{"caseInsensitive":true,"onlyMatching":true,"contextLines":2,"maxResults":9,"maxFileBytes":10}`),
			want:   []string{`"case_insensitive":true`, `"only_matching":true`, `"context_lines":2`, `"max_results":9`, `"max_file_bytes":10`},
			absent: []string{"caseInsensitive", "onlyMatching", "contextLines", "maxResults", "maxFileBytes"},
		},
		{
			name:   "glob snake_case",
			msg:    oldToolCall("glob", `{"caseSensitive":true,"filesOnly":true,"respectGitignore":true}`),
			want:   []string{`"case_sensitive":true`, `"files_only":true`, `"respect_gitignore":true`},
			absent: []string{"caseSensitive", "filesOnly", "respectGitignore"},
		},
		{
			name:   "fetch_url snake_case",
			msg:    oldToolCall("fetch_url", `{"timeoutSec":10,"maxChars":100}`),
			want:   []string{`"timeout_sec":10`, `"max_chars":100`},
			absent: []string{"timeoutSec", "maxChars"},
		},
		{
			name:   "inspect snake_case",
			msg:    oldToolCall("inspect", `{"gitStatus":false,"showHidden":true,"maxEntries":2}`),
			want:   []string{`"git_status":false`, `"show_hidden":true`, `"max_entries":2`},
			absent: []string{"gitStatus", "showHidden", "maxEntries"},
		},
		{
			name:   "edit snake_case",
			msg:    oldToolCall("edit", `{"oldText":"a","newText":"b","workdir":"/tmp"}`),
			want:   []string{`"old_text":"a"`, `"new_text":"b"`, `"work_dir":"/tmp"`},
			absent: []string{"oldText", "newText", "workdir"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, _ := migrateOneMessage(t, tc.msg)
			for _, want := range tc.want {
				if !contains(got, want) {
					t.Fatalf("missing %q in %s", want, got)
				}
			}
			for _, absent := range tc.absent {
				if contains(got, absent) {
					t.Fatalf("legacy %q survived in %s", absent, got)
				}
			}
			// Idempotent: a second pass changes nothing.
			again, ok := migrateOneMessage(t, got)
			if ok || again != got {
				t.Fatalf("second pass must be a no-op: %s", again)
			}
		})
	}
}

// A collision must never lose the current value: the legacy key is dropped.
func TestV4RenameArgsKeepsNewerValueOnCollision(t *testing.T) {
	got, _ := migrateOneMessage(t, oldToolCall("mark_task_as_complete", `{"comprehensive_summary":null,"notes":"legacy","final_message_to_user":"current"}`))
	if !contains(got, `"final_message_to_user":"current"`) {
		t.Fatalf("current value lost: %s", got)
	}
	if contains(got, "legacy") || contains(got, "notes") || contains(got, "comprehensive_summary") {
		t.Fatalf("legacy keys survived: %s", got)
	}
}

// Tool result blocks (call_id/content/is_error, plus details) are untouched.
func TestV4LeavesToolResultsAndAddedTools(t *testing.T) {
	msg := `{"role":"tool","content":[{"call_id":"tu_1","is_error":false,"content":[{"text":"ok"}],"details":{"status":"timeout","summary":"waiting for build"}}],"added_tool_names":["sleep","sleep","mark_task_as_complete"]}`
	got, ok := migrateOneMessage(t, msg)
	if !ok {
		t.Fatal("added_tool_names must be rewritten")
	}
	if !contains(got, `"details":{"status":"timeout","summary":"waiting for build"}`) {
		t.Fatalf("details must be preserved byte-for-byte as values: %s", got)
	}
	if !contains(got, `"added_tool_names":["bg_await","finish_entire_request"]`) {
		t.Fatalf("added_tool_names not deduped/renamed: %s", got)
	}
	again, ok := migrateOneMessage(t, got)
	if ok || again != got {
		t.Fatalf("second pass must be a no-op: %s", again)
	}
}

// findLegacyVocabulary reports what is left behind (used by Verify).
func TestV4FindLegacyVocabulary(t *testing.T) {
	if got := findLegacyVocabulary(json.RawMessage(oldToolCall("sleep", `{"waitingFor":"bg_1"}`))); got == "" {
		t.Fatal("legacy tool name must be reported")
	}
	if got := findLegacyVocabulary(json.RawMessage(oldToolCall("summary", `{"summary":"x"}`))); got != "" {
		t.Fatalf("summary tool argument is legitimate, got %q", got)
	}
	clean, _ := migrateOneMessage(t, oldToolCall("bg_await", `{"max_wait_seconds":1,"waiting_for":"bg_1","reason":"r"}`))
	if got := findLegacyVocabulary(json.RawMessage(clean)); got != "" {
		t.Fatalf("clean message reported as legacy: %q", got)
	}
}

func contains(haystack, needle string) bool {
	return len(needle) == 0 || (len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0)
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
