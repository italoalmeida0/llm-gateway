package main

import (
	"strings"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/core"
)

// registryForTest builds a registry with every builtin tool name so
// modeRegistry filtering can be asserted per mode.
func registryForTest() core.Registry {
	return core.NewRegistry(
		&tools.ReadTool{}, &tools.WriteTool{}, &tools.EditTool{},
		&tools.BashTool{}, &tools.PythonTool{}, &tools.GlobTool{}, &tools.SearchTool{},
		&tools.InspectTool{}, &tools.SearchWebTool{}, &tools.FetchURLTool{},
		&tools.QuestionTool{}, &tools.TodoTool{}, &tools.SummaryTool{},
		&tools.FinishEntireRequestTool{},
		&tools.BgAwaitTool{}, &tools.BgCheckTool{}, &tools.BgCancelTool{},
	)
}

func registryNames(reg core.Registry) map[string]bool {
	names := map[string]bool{}
	for name := range reg {
		names[name] = true
	}
	return names
}

// Each mode advertises exactly its allowlist: tools from other modes are
// absent, so the model never sees names or descriptions it cannot call.
func TestModeRegistryAllowlistPerMode(t *testing.T) {
	full := registryForTest()
	for mode, want := range map[string][]string{
		"build": {
			"read", "write", "edit", "bash", "python", "glob", "search", "inspect",
			"search_web", "fetch_url", "question", "todo", "summary",
			"bg_await", "bg_check", "bg_cancel", "finish_entire_request",
		},
		"plan": {
			"read", "bash", "python", "glob", "search", "inspect",
			"search_web", "fetch_url", "question", "todo", "summary",
			"bg_await", "bg_check", "bg_cancel", "finish_entire_request",
		},
		"learning": {
			"read", "bash", "python", "glob", "search", "inspect",
			"search_web", "fetch_url", "question", "todo", "summary",
			"bg_await", "bg_check", "bg_cancel", "finish_entire_request",
		},
		"talk": {
			"search_web", "fetch_url", "question", "todo",
		},
	} {
		got := registryNames(modeRegistry(full, mode))
		for _, name := range want {
			if !got[name] {
				t.Errorf("mode %q: missing tool %q", mode, name)
			}
		}
		if len(got) != len(want) {
			t.Errorf("mode %q: registry has %d tools, want %d (%v)", mode, len(got), len(want), got)
		}
	}
}

// plan and learning never advertise edit/create tools; talk never
// advertises workspace tools.
func TestModeRegistryExcludesForeignModeTools(t *testing.T) {
	full := registryForTest()
	for _, mode := range []string{"plan", "learning", "talk"} {
		names := registryNames(modeRegistry(full, mode))
		for _, banned := range []string{"write", "edit", "patch"} {
			if names[banned] {
				t.Errorf("mode %q must not advertise %q", mode, banned)
			}
		}
	}
	talk := registryNames(modeRegistry(full, "talk"))
	for _, banned := range []string{"read", "bash", "python", "glob", "search", "inspect", "summary", "bg_await", "bg_check", "bg_cancel", "finish_entire_request"} {
		if talk[banned] {
			t.Errorf("talk must not advertise %q", banned)
		}
	}
	// The completion signal is the SAME tool in every workspace mode.
	for _, mode := range []string{"build", "plan", "learning"} {
		if !registryNames(modeRegistry(full, mode))["finish_entire_request"] {
			t.Errorf("mode %q must advertise finish_entire_request", mode)
		}
	}
}

// The system prompt is rebuilt per mode and must be self-contained: it
// describes the active mode and never the sibling modes.
func TestSessionSystemPromptIsModeClean(t *testing.T) {
	cfg := DaemonConfig{}
	modeNames := map[string]string{
		"build": "Build mode", "plan": "Plan mode",
		"learning": "Learning mode", "talk": "Talk mode",
	}
	completionTools := map[string]string{
		"build": "finish_entire_request", "plan": "finish_entire_request",
		"learning": "finish_entire_request", "talk": "",
	}
	for _, mode := range []string{"build", "plan", "learning", "talk"} {
		prompt := sessionSystemPrompt(cfg, "/tmp/work", SessionOptions{Mode: mode})
		for _, leak := range []string{"Modes of operation", "current active mode", "system-reminder> at the beginning", "Build and Learning", "Plan and Learning", "build and learning", "switch to"} {
			if strings.Contains(prompt, leak) {
				t.Errorf("prompt for mode %q leaks %q", mode, leak)
			}
		}
		// Sibling mode names must never appear; the active mode's own name is fine.
		for other, name := range modeNames {
			if other == mode {
				continue
			}
			if strings.Contains(prompt, name) {
				t.Errorf("prompt for mode %q leaks sibling mode %q", mode, name)
			}
		}
		// No legacy completion tool name may ever appear again.
		for _, name := range []string{"mark_task_as_complete", "mark_plan_as_ready_to_execute"} {
			if name == completionTools[mode] {
				continue
			}
			if strings.Contains(prompt, name) {
				t.Errorf("prompt for mode %q leaks foreign completion tool %q", mode, name)
			}
		}
		if want := completionTools[mode]; want != "" && !strings.Contains(prompt, want) {
			t.Errorf("prompt for mode %q does not name its completion tool %q", mode, want)
		}
	}
}

// The completion tool description is mode-specific: the learning variant
// carries the tutoring contract, the build variant does not mention it.
func TestMarkTaskDescriptionPerMode(t *testing.T) {
	build := (&tools.FinishEntireRequestTool{Mode: "build"}).Description()
	learning := (&tools.FinishEntireRequestTool{Mode: "learning"}).Description()
	if build == learning {
		t.Fatalf("build and learning descriptions must differ")
	}
	if strings.Contains(build, "guiding question") || strings.Contains(build, "solution") {
		t.Errorf("build description leaks learning guidance: %q", build)
	}
	if !strings.Contains(learning, "guiding question") {
		t.Errorf("learning description missing tutoring contract: %q", learning)
	}
	for _, desc := range []string{build, learning} {
		for _, leak := range []string{"Build or Learning", "in Plan mode", "Learning mode", "Build mode"} {
			if strings.Contains(desc, leak) {
				t.Errorf("description %q leaks %q", desc, leak)
			}
		}
	}
	plan := (&tools.FinishEntireRequestTool{Mode: "plan"}).Description()
	if strings.Contains(plan, "Plan mode") {
		t.Errorf("plan description leaks mode name: %q", plan)
	}
	// One tool, one name: only the description varies with the mode.
	if (&tools.FinishEntireRequestTool{Mode: "plan"}).Name() != (&tools.FinishEntireRequestTool{Mode: "build"}).Name() {
		t.Errorf("plan and build must expose the same tool name")
	}
}

// Tool descriptions must not enumerate the modes they are available in —
// availability is expressed by the per-mode registry alone.
func TestToolDescriptionsDoNotEnumerateModes(t *testing.T) {
	all := []core.Tool{
		&tools.ReadTool{}, &tools.WriteTool{}, &tools.EditTool{},
		&tools.BashTool{}, &tools.GlobTool{}, &tools.SearchTool{},
		&tools.InspectTool{}, &tools.SearchWebTool{}, &tools.FetchURLTool{},
		&tools.QuestionTool{}, &tools.TodoTool{}, &tools.SummaryTool{},
		&tools.FinishEntireRequestTool{Mode: "build"}, &tools.FinishEntireRequestTool{Mode: "plan"},
		&tools.BgAwaitTool{}, &tools.BgCheckTool{}, &tools.BgCancelTool{},
	}
	for _, tool := range all {
		desc := tool.Description()
		for _, leak := range []string{"Available in", "only available", "Build or Learning", "plan, build and learning", "in Plan mode", "in Build mode", "in Learning mode", "in talk mode"} {
			if strings.Contains(desc, leak) {
				t.Errorf("%s description leaks availability %q: %q", tool.Name(), leak, desc)
			}
		}
	}
}
