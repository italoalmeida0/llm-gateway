package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/agent/tools"
	"llm-gateway/indirect-code-daemon/packages/core"
)

func TestSessionChoicesPersistIndependentlyAndRememberLastSelection(t *testing.T) {
	d := testDaemon(t)
	d.configPath = filepath.Join(d.dataDir, "config.json")
	for _, id := range []string{"one", "two"} {
		if err := d.saveSession(&SessionRecord{ID: id, Model: "first", Status: "idle"}); err != nil {
			t.Fatal(err)
		}
	}
	d.handleMessage([]byte(`{"type":"configure_session","sessionId":"one","model":"custom/one","options":{"effort":"high","mode":"learning","skills":["review","style"],"access":"ask"}}`))
	d.handleMessage([]byte(`{"type":"configure_session","sessionId":"two","model":"custom/two","options":{"effort":"low","mode":"plan","access":"full"}}`))
	one, err := d.loadSession("one")
	if err != nil {
		t.Fatal(err)
	}
	two, err := d.loadSession("two")
	if err != nil {
		t.Fatal(err)
	}
	if one.Model != "custom/one" || one.Options.Effort != "high" || one.Options.Mode != "learning" || len(one.Options.Skills) != 2 || one.Options.Access != "ask" {
		t.Fatalf("first session choices were overwritten: %+v", one.Options)
	}
	if two.Model != "custom/two" || two.Options.Effort != "low" || d.config.LastSelection.Model != "custom/two" || d.config.LastSelection.Effort != "low" {
		t.Fatal("last choice was not remembered independently")
	}

	if d.config.LastSelection.Mode != "plan" || d.config.LastSelection.Access != "full" {
		t.Fatal("agent/access were not remembered")
	}
	d.handleMessage([]byte(`{"type":"create_session"}`))
	created := d.listSessions()
	var inherited *SessionRecord
	for _, summary := range created {
		if summary.ID != "one" && summary.ID != "two" {
			inherited, _ = d.loadSession(summary.ID)
		}
	}
	if inherited == nil || inherited.Model != "custom/two" || inherited.Options.Mode != "plan" || inherited.Options.Access != "full" || inherited.Options.Effort != "low" {
		t.Fatal("new session did not inherit latest choices")
	}
	d.handleMessage([]byte(`{"type":"update_config","settings":{"temperature":0.2},"skills":{"review":{"name":"review","enabled":true},"style":{"name":"style","enabled":true}}}`))
	var saved DaemonConfig
	data, err := os.ReadFile(d.configPath)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.LastSelection.Model != "custom/two" || len(saved.Skills) != 2 || !saved.Settings.NoAutoTitle {
		t.Fatal("saving settings lost choices, a skill, or omitted settings")
	}
	if normalizedOptions(SessionOptions{}).Effort != "medium" {
		t.Fatal("first choice must default to medium")
	}
}

func TestBrowseFoldersNavigatesWithoutCreatingPaths(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{".config", "project", "other"} {
		if err := os.Mkdir(filepath.Join(root, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	path, parent, entries, err := browseFolders(root)
	if err != nil || path != root || parent != filepath.Dir(root) || len(entries) != 3 || entries[0].Name != ".config" {
		t.Fatalf("unexpected folder listing: %q %q %+v %v", path, parent, entries, err)
	}
	if _, _, _, err := browseFolders(filepath.Join(root, "missing")); err == nil {
		t.Fatal("missing folder should fail")
	}
	if _, err := os.Stat(filepath.Join(root, "missing")); !os.IsNotExist(err) {
		t.Fatal("browsing created a folder")
	}
}

func TestModesExposeTheirIntendedTools(t *testing.T) {
	for _, mode := range []string{"plan", "learning", "talk", "build"} {
		reg := core.NewRegistry(
			&tools.ReadTool{}, &tools.GlobTool{}, &tools.BashTool{}, &tools.PythonTool{},
			&tools.WriteTool{}, &tools.EditTool{},
			&tools.SearchTool{}, &tools.InspectTool{},
			&tools.SearchWebTool{}, &tools.FetchURLTool{},
			&tools.TodoTool{}, &tools.QuestionTool{},
			&tools.MarkTaskAsCompleteTool{}, &tools.MarkPlanAsReadyToExecuteTool{},
		)
		restrictModeTools(reg, mode)
		if mode == "talk" {
			for _, keep := range []string{"question", "search_web", "fetch_url", "todo"} {
				if reg[keep] == nil {
					t.Fatalf("Talk must retain %s", keep)
				}
			}
			for _, drop := range []string{"read", "write", "edit", "search", "inspect", "bash", "python", "glob", "mark_task_as_complete", "mark_plan_as_ready_to_execute"} {
				if reg[drop] != nil {
					t.Fatalf("Talk must not expose %s (no workspace access)", drop)
				}
			}
		} else {
			// Build, Plan, and Learning share the exact same tool registry
			// to guarantee >95% prefix KV cache hits across mode switches.
			for _, want := range []string{"read", "write", "edit", "search", "inspect", "bash", "python", "glob", "todo", "question", "search_web", "fetch_url", "mark_task_as_complete", "mark_plan_as_ready_to_execute"} {
				if reg[want] == nil {
					t.Fatalf("Mode %s must expose %s in tool registry for KV cache reuse", mode, want)
				}
			}
		}

		if modeInstructions(mode) == "" {
			t.Fatal("missing mode instructions")
		}
	}

	// Mode restrictions are enforced at runtime via modeToolRestriction.
	// Build mode:
	if r := modeToolRestriction("build", "write"); r != "" {
		t.Fatalf("build should allow write, got %q", r)
	}
	if r := modeToolRestriction("build", "bash"); r != "" {
		t.Fatalf("build should allow bash, got %q", r)
	}
	if r := modeToolRestriction("build", "mark_task_as_complete"); r != "" {
		t.Fatalf("build should allow mark_task_as_complete, got %q", r)
	}
	if r := modeToolRestriction("build", "mark_plan_as_ready_to_execute"); r == "" {
		t.Fatal("build should restrict mark_plan_as_ready_to_execute")
	}

	// Plan mode:
	if r := modeToolRestriction("plan", "write"); r == "" {
		t.Fatal("plan should restrict write")
	}
	if r := modeToolRestriction("plan", "edit"); r == "" {
		t.Fatal("plan should restrict edit")
	}
	if r := modeToolRestriction("plan", "bash"); r != "" {
		t.Fatalf("plan should allow bash for inspection, got %q", r)
	}
	if r := modeToolRestriction("plan", "mark_plan_as_ready_to_execute"); r != "" {
		t.Fatalf("plan should allow mark_plan_as_ready_to_execute, got %q", r)
	}
	if r := modeToolRestriction("plan", "mark_task_as_complete"); r == "" {
		t.Fatal("plan should restrict mark_task_as_complete")
	}

	// Learning mode:
	if r := modeToolRestriction("learning", "write"); r == "" {
		t.Fatal("learning should restrict write")
	}
	if r := modeToolRestriction("learning", "bash"); r != "" {
		t.Fatalf("learning should allow bash for testing, got %q", r)
	}
	if r := modeToolRestriction("learning", "python"); r != "" {
		t.Fatalf("learning should allow python for testing, got %q", r)
	}
	if r := modeToolRestriction("learning", "mark_task_as_complete"); r == "" {
		t.Fatal("learning should restrict mark_task_as_complete")
	}
	if r := modeToolRestriction("learning", "mark_plan_as_ready_to_execute"); r == "" {
		t.Fatal("learning should restrict mark_plan_as_ready_to_execute")
	}

	// Talk mode:
	for _, tool := range []string{"read", "write", "edit", "bash", "python"} {
		if r := modeToolRestriction("talk", tool); r == "" {
			t.Fatalf("talk should restrict workspace tool %s", tool)
		}
	}
}
