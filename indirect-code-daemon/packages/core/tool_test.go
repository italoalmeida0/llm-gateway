package core

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

type registryProbeTool struct{ name string }

func (t registryProbeTool) Name() string            { return t.name }
func (t registryProbeTool) Description() string     { return "probe" }
func (t registryProbeTool) Schema() json.RawMessage { return json.RawMessage(`{}`) }
func (t registryProbeTool) Execute(ctx context.Context, args json.RawMessage, progress func(string)) (ToolResult, error) {
	return ToolResult{}, nil
}

func TestRegistryGetUnknownToolListsAlternatives(t *testing.T) {
	reg := NewRegistry(
		registryProbeTool{name: "search"},
		registryProbeTool{name: "glob"},
		registryProbeTool{name: "read"},
	)
	_, err := reg.Get("grep")
	if err == nil {
		t.Fatal("Get(grep) should fail")
	}
	msg := err.Error()
	if !strings.Contains(msg, `unknown tool "grep"`) {
		t.Fatalf("error should name the unknown tool: %q", msg)
	}
	if !strings.Contains(msg, `"search"`) {
		t.Fatalf("error should suggest the closest tool: %q", msg)
	}
	for _, name := range []string{"glob", "read", "search"} {
		if !strings.Contains(msg, name) {
			t.Fatalf("error should list available tool %q: %q", name, msg)
		}
	}
}

func TestRegistryGetUnknownToolWithoutNearMatchStillLists(t *testing.T) {
	reg := NewRegistry(registryProbeTool{name: "read"})
	_, err := reg.Get("mark_task_complete_placeholder")
	if err == nil {
		t.Fatal("Get should fail for an unknown name")
	}
	msg := err.Error()
	if !strings.Contains(msg, "Available tools: read") {
		t.Fatalf("error should list the registry contents: %q", msg)
	}
}

func TestRegistryGetPatchAlias(t *testing.T) {
	reg := NewRegistry(registryProbeTool{name: "edit"})
	tool, err := reg.Get("patch")
	if err != nil {
		t.Fatalf("patch alias should resolve: %v", err)
	}
	if tool.Name() != "edit" {
		t.Fatalf("patch should resolve to edit, got %q", tool.Name())
	}
}
