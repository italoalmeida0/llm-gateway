package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/core"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestApplyGatewayPricingFirstMatchWins(t *testing.T) {
	var m provider.Model
	applyGatewayPricing(&m, map[string]float64{
		"prompt": 3, "input": 99,
		"completion": 15,
		"input_cache_reads": 0.3,
		"cache_write":       0.6,
	})
	if m.PriceInput != 3 || m.PriceOutput != 15 || m.PriceCacheRead != 0.3 || m.PriceCacheWrite != 0.6 {
		t.Fatalf("pricing=%+v", m)
	}
	var empty provider.Model
	applyGatewayPricing(&empty, nil)
	if empty.PriceInput != 0 || empty.PriceOutput != 0 {
		t.Fatalf("empty pricing must stay zero: %+v", empty)
	}
}

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
	for _, mode := range []string{"plan", "build", "learning"} {
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
	for _, mode := range []string{"talk", "", "other"} {
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
	learningPrompt := sessionSystemPrompt(DaemonConfig{}, "/tmp", SessionOptions{Mode: "learning"})
	if buildPrompt != planPrompt || buildPrompt != learningPrompt {
		t.Fatalf("build, plan, and learning system prompts must be identical for prompt caching:\n--- build ---\n%s\n--- plan ---\n%s\n--- learning ---\n%s", buildPrompt, planPrompt, learningPrompt)
	}
}

func TestCompletionToolsModeRestrictions(t *testing.T) {
	// Build, plan, and learning retain the exact same tool set in the wire registry
	// to maximize KV cache reuse across mode switches.
	for _, mode := range []string{"build", "plan", "learning"} {
		reg := core.Registry{
			"write":                        nil,
			"edit":                         nil,
			"bash":                         nil,
			"mark_task_as_complete":        nil,
			"mark_plan_as_ready_to_execute": nil,
		}
		restrictModeTools(reg, mode)
		if _, ok := reg["mark_task_as_complete"]; !ok {
			t.Fatalf("expected mark_task_as_complete retained in %s mode for KV cache", mode)
		}
		if _, ok := reg["mark_plan_as_ready_to_execute"]; !ok {
			t.Fatalf("expected mark_plan_as_ready_to_execute retained in %s mode for KV cache", mode)
		}
		if _, ok := reg["write"]; !ok {
			t.Fatalf("expected write retained in %s mode for KV cache", mode)
		}
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

// LastDate/LastMode drive the dynamic <system-reminder> directives. The
// on-disk round-trip must keep them: dropping them on load makes the
// first turn after a restart re-emit the date/mode reminder (and bust
// the prompt-cache prefix the directive scheme exists to protect).
func TestLoadSessionPreservesDirectiveState(t *testing.T) {
	d := &DaemonServer{dataDir: t.TempDir(), config: &DaemonConfig{HostID: "host-test"}, sessions: map[string]*ActiveSession{}}
	rec := &SessionRecord{
		ID: "sess_directives", CWD: t.TempDir(), Status: "idle",
		CreatedAt: 1, UpdatedAt: 1,
		LastDate: "2026-09-13", LastMode: "build",
	}
	if err := d.saveSession(rec); err != nil {
		t.Fatal(err)
	}
	back, err := d.loadSession(rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if back.LastDate != "2026-09-13" || back.LastMode != "build" {
		t.Fatalf("directive state lost on load: LastDate=%q LastMode=%q", back.LastDate, back.LastMode)
	}
	// The restored state must suppress the reminder on the same day/mode.
	if got := buildTurnSystemDirectives(back, "build", time.Date(2026, 9, 13, 10, 0, 0, 0, time.UTC)); got != "" {
		t.Fatalf("expected no directives after round-trip, got:\n%s", got)
	}
}
