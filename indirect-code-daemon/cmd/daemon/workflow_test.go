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
			// Talk has its own assertions below (no workspace tools at all).
		} else if mode == "build" {
			if reg["write"] == nil || reg["edit"] == nil || reg["mark_task_as_complete"] == nil || reg["mark_plan_as_ready_to_execute"] != nil {
				t.Fatal("Build mode must have write/edit/mark_task_as_complete and not mark_plan_as_ready_to_execute")
			}
		} else {
			if reg["write"] != nil || reg["edit"] != nil || reg["read"] == nil || reg["glob"] == nil || reg["todo"] == nil {
				t.Fatal("mode exposed the wrong file tools or lost the checklist")
			}
			if reg["search"] == nil || reg["inspect"] == nil {
				t.Fatal("Plan and Learning must retain exploration tools (search/inspect)")
			}
		}
		if mode != "talk" && reg["question"] == nil {
			t.Fatal("Plan, Learning and Build must retain questions")
		}
		if mode == "plan" {
			if reg["bash"] == nil {
				t.Fatal("Plan must retain shell commands for read-only inspection")
			}
			if reg["mark_plan_as_ready_to_execute"] == nil || reg["mark_task_as_complete"] != nil {
				t.Fatal("Plan must retain mark_plan_as_ready_to_execute and drop mark_task_as_complete")
			}
		}
		if mode == "learning" {
			if reg["bash"] != nil || reg["python"] != nil {
				t.Fatal("Learning must not execute code (read-only observation)")
			}
			if reg["mark_task_as_complete"] != nil || reg["mark_plan_as_ready_to_execute"] != nil {
				t.Fatal("Learning must not have completion tools")
			}
		}
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
		}
		if modeInstructions(mode) == "" {
			t.Fatal("missing mode instructions")
		}
	}
}
