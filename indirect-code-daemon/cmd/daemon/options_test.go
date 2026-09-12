package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
)

func TestSessionSystemPromptIncludesSystemDirectivesAndOmitsDate(t *testing.T) {
	prompt := sessionSystemPrompt(DaemonConfig{}, "/tmp", SessionOptions{Mode: "build"})
	if !strings.Contains(prompt, "System directives: The user's input may be prepended with a <system-reminder>") {
		t.Fatalf("system prompt missing system directives notice:\n%s", prompt)
	}
	if strings.Contains(prompt, "Current date") {
		t.Fatalf("system prompt should not include dynamic date (must be static for prompt caching):\n%s", prompt)
	}
}

func TestBrainInstructionsModes(t *testing.T) {
	brain := filepath.Join(t.TempDir(), "brain", "sess_1")
	for _, mode := range []string{"plan", "build"} {
		text := brainInstructions(mode, brain)
		if text == "" {
			t.Fatalf("mode %q should include session memory instructions", mode)
		}
		for _, want := range []string{brain, "notes.md", "Do not mention this space"} {
			if !strings.Contains(text, want) {
				t.Fatalf("mode %q instructions missing %q:\n%s", mode, want, text)
			}
		}
	}
	for _, mode := range []string{"talk", "learning", "", "other"} {
		if got := brainInstructions(mode, brain); got != "" {
			t.Fatalf("mode %q should not include session memory instructions: %q", mode, got)
		}
	}
	if got := brainInstructions("build", ""); got != "" {
		t.Fatalf("empty brain dir should yield no instructions: %q", got)
	}
}

func TestProjectContextSection(t *testing.T) {
	t.Run("agents preferred with claude fallback", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("# agents rules"), 0o644); err != nil {
			t.Fatal(err)
		}
		got := projectContextSection(dir)
		if !strings.Contains(got, "# agents rules") || !strings.Contains(got, "Project context (AGENTS.md)") {
			t.Fatalf("missing agents content:\n%s", got)
		}
		if err := os.WriteFile(filepath.Join(dir, "claude.md"), []byte("# claude rules"), 0o644); err != nil {
			t.Fatal(err)
		}
		got = projectContextSection(dir)
		if !strings.Contains(got, "# claude rules") {
			t.Fatalf("claude.md should also load when both exist:\n%s", got)
		}
		if strings.Index(got, "AGENTS.md") > strings.Index(got, "claude.md") {
			t.Fatalf("AGENTS.md should come first:\n%s", got)
		}
	})
	t.Run("case insensitive", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "Agents.MD"), []byte("# mixed case"), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := projectContextSection(dir); !strings.Contains(got, "# mixed case") {
			t.Fatalf("case-insensitive match failed:\n%s", got)
		}
	})
	t.Run("missing is silent", func(t *testing.T) {
		if got := projectContextSection(t.TempDir()); got != "" {
			t.Fatalf("want empty, got %q", got)
		}
		if got := projectContextSection(""); got != "" {
			t.Fatalf("want empty, got %q", got)
		}
		if got := projectContextSection(filepath.Join(t.TempDir(), "nope")); got != "" {
			t.Fatalf("want empty, got %q", got)
		}
	})
	t.Run("truncated when huge", func(t *testing.T) {
		dir := t.TempDir()
		big := strings.Repeat("x", maxProjectContextBytes+100)
		if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte(big), 0o644); err != nil {
			t.Fatal(err)
		}
		got := projectContextSection(dir)
		if !strings.Contains(got, "[... truncated ...]") || len(got) > maxProjectContextBytes+512 {
			t.Fatalf("huge file should be capped, len=%d", len(got))
		}
	})
}

func TestSystemPromptIncludesProjectContextInBuildOnly(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("# proj rules"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := systemPromptWithBrain(DaemonConfig{}, dir, SessionOptions{Mode: "build"}, ""); !strings.Contains(got, "# proj rules") {
		t.Fatalf("build prompt should include project context:\n%s", got)
	}
	if got := systemPromptWithBrain(DaemonConfig{}, dir, SessionOptions{Mode: "talk"}, ""); strings.Contains(got, "# proj rules") {
		t.Fatalf("talk prompt should not include project context:\n%s", got)
	}
}

func TestSystemPromptWithBrain(t *testing.T) {
	brain := filepath.Join(t.TempDir(), "brain", "sess_1")
	with := systemPromptWithBrain(DaemonConfig{}, "/tmp", SessionOptions{Mode: "build"}, brain)
	if !strings.Contains(with, brain) {
		t.Fatalf("build prompt should include brain path:\n%s", with)
	}
	without := systemPromptWithBrain(DaemonConfig{}, "/tmp", SessionOptions{Mode: "talk"}, brain)
	if strings.Contains(without, brain) {
		t.Fatalf("talk prompt should not include brain path:\n%s", without)
	}
}

func TestSessionSystemPromptIncludesOSAndShell(t *testing.T) {
	prompt := sessionSystemPrompt(DaemonConfig{}, "/tmp", SessionOptions{Mode: "build"})
	want := "OS: " + runtime.GOOS + "/" + runtime.GOARCH + ", Shell: "
	if !strings.Contains(prompt, want) {
		t.Fatalf("system prompt missing %q:\n%s", want, prompt)
	}
}

func TestBuildAndPlanShareIdenticalSystemPrompt(t *testing.T) {
	buildPrompt := sessionSystemPrompt(DaemonConfig{}, "/tmp", SessionOptions{Mode: "build"})
	planPrompt := sessionSystemPrompt(DaemonConfig{}, "/tmp", SessionOptions{Mode: "plan"})
	if buildPrompt != planPrompt {
		t.Fatalf("build and plan system prompts must be identical for prompt caching:\n--- build ---\n%s\n--- plan ---\n%s", buildPrompt, planPrompt)
	}
}

func TestCompletionToolsModeRestrictions(t *testing.T) {
	buildReg := core.Registry{
		"write":                        nil,
		"edit":                         nil,
		"bash":                         nil,
		"mark_task_as_complete":        nil,
		"mark_plan_as_ready_to_execute": nil,
	}
	restrictModeTools(buildReg, "build")
	if _, ok := buildReg["mark_task_as_complete"]; !ok {
		t.Fatal("expected mark_task_as_complete in build mode")
	}
	if _, ok := buildReg["mark_plan_as_ready_to_execute"]; ok {
		t.Fatal("did not expect mark_plan_as_ready_to_execute in build mode")
	}

	planReg := core.Registry{
		"read":                         nil,
		"write":                        nil,
		"edit":                         nil,
		"mark_task_as_complete":        nil,
		"mark_plan_as_ready_to_execute": nil,
	}
	restrictModeTools(planReg, "plan")
	if _, ok := planReg["mark_plan_as_ready_to_execute"]; !ok {
		t.Fatal("expected mark_plan_as_ready_to_execute in plan mode")
	}
	if _, ok := planReg["mark_task_as_complete"]; ok {
		t.Fatal("did not expect mark_task_as_complete in plan mode")
	}
	if _, ok := planReg["write"]; ok {
		t.Fatal("did not expect write in plan mode")
	}

	talkReg := core.Registry{
		"read":                         nil,
		"mark_task_as_complete":        nil,
		"mark_plan_as_ready_to_execute": nil,
	}
	restrictModeTools(talkReg, "talk")
	if _, ok := talkReg["mark_task_as_complete"]; ok || talkReg["mark_plan_as_ready_to_execute"] != nil {
		t.Fatal("expected completion tools removed in talk mode")
	}
}

func TestBrainInstructionsDirectAccessRule(t *testing.T) {
	brain := filepath.Join(t.TempDir(), "brain", "sess_1")
	text := brainInstructions("build", brain)
	if !strings.Contains(text, "ALWAYS ACCESS DIRECTLY") {
		t.Fatalf("expected brain instructions to tell AI to access directly with file tools:\n%s", text)
	}
	if !strings.Contains(text, "NEVER use shell or terminal commands") {
		t.Fatalf("expected brain instructions to forbid shell commands for session memory:\n%s", text)
	}
}

func TestBuildTurnSystemDirectives(t *testing.T) {
	rec := &SessionRecord{}
	now := time.Date(2026, 9, 12, 10, 0, 0, 0, time.UTC)

	// First call: both date and mode are unset, so both should be emitted
	first := buildTurnSystemDirectives(rec, "build", now)
	if !strings.Contains(first, "Current date: Saturday, 2026-09-12") {
		t.Fatalf("expected date in initial directives:\n%s", first)
	}
	if !strings.Contains(first, "Operational mode: Build") {
		t.Fatalf("expected mode in initial directives:\n%s", first)
	}
	if !strings.HasPrefix(first, "<system-reminder>\n") || !strings.HasSuffix(first, "\n</system-reminder>") {
		t.Fatalf("directives not properly enclosed in <system-reminder>:\n%s", first)
	}
	if rec.LastDate != "2026-09-12" || rec.LastMode != "build" {
		t.Fatalf("record state not updated: LastDate=%q, LastMode=%q", rec.LastDate, rec.LastMode)
	}

	// Repeated call on the same day and mode: returns empty string
	second := buildTurnSystemDirectives(rec, "build", now)
	if second != "" {
		t.Fatalf("expected empty directives on same day and mode, got:\n%s", second)
	}

	// Mode switch: only mode is emitted, date is skipped
	modeSwitch := buildTurnSystemDirectives(rec, "plan", now)
	if strings.Contains(modeSwitch, "Current date") {
		t.Fatalf("date should not be included when date has not changed:\n%s", modeSwitch)
	}
	if !strings.Contains(modeSwitch, "Operational mode: Plan") {
		t.Fatalf("expected plan mode in directives:\n%s", modeSwitch)
	}
	if rec.LastMode != "plan" {
		t.Fatalf("record LastMode not updated: %q", rec.LastMode)
	}

	// Next day: only date is emitted, mode is skipped
	nextDay := now.Add(24 * time.Hour)
	daySwitch := buildTurnSystemDirectives(rec, "plan", nextDay)
	if !strings.Contains(daySwitch, "Current date: Sunday, 2026-09-13") {
		t.Fatalf("expected new date in directives:\n%s", daySwitch)
	}
	if strings.Contains(daySwitch, "Operational mode") {
		t.Fatalf("mode should not be included when mode has not changed:\n%s", daySwitch)
	}
	if rec.LastDate != "2026-09-13" {
		t.Fatalf("record LastDate not updated: %q", rec.LastDate)
	}
}


