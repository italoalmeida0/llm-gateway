package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestBrainAccessAllowedInJail(t *testing.T) {
	root := t.TempDir()
	brain := t.TempDir()

	sb := NewSandbox(root)
	sb.AllowExtra(brain)
	sb.Lock()

	notesFile := filepath.Join(brain, "notes.md")

	// 1. WriteTool can write to brain directory when jailed
	writeTool := &WriteTool{CWD: root, Sandbox: sb, BrainDir: brain}
	writeArgs, _ := json.Marshal(map[string]string{
		"path":    notesFile,
		"content": "# Session Notes\n- Initial observation\n",
	})
	if _, err := writeTool.Execute(context.Background(), writeArgs, nil); err != nil {
		t.Fatalf("WriteTool failed to write in brain directory when jailed: %v", err)
	}

	data, err := os.ReadFile(notesFile)
	if err != nil || string(data) != "# Session Notes\n- Initial observation\n" {
		t.Fatalf("unexpected notes content: %q (err: %v)", string(data), err)
	}

	// 2. ReadTool can read from brain directory when jailed
	readTool := &ReadTool{CWD: root, Sandbox: sb, BrainDir: brain}
	readArgs, _ := json.Marshal(map[string]string{
		"path": notesFile,
	})
	readRes, err := readTool.Execute(context.Background(), readArgs, nil)
	if err != nil {
		t.Fatalf("ReadTool failed to read in brain directory when jailed: %v", err)
	}
	if len(readRes.Content) == 0 {
		t.Fatal("expected content from ReadTool")
	}
	tb, ok := readRes.Content[0].(provider.TextBlock)
	if !ok || len(tb.Text) == 0 {
		t.Fatalf("unexpected read content: %v", readRes.Content[0])
	}

	// 3. EditTool can edit in brain directory when jailed
	editTool := &EditTool{CWD: root, Sandbox: sb, BrainDir: brain}
	editArgs, _ := json.Marshal(map[string]any{
		"path": notesFile,
		"edits": []map[string]string{
			{
				"oldText": "- Initial observation",
				"newText": "- Initial observation\n- Second observation",
			},
		},
	})
	if _, err := editTool.Execute(context.Background(), editArgs, nil); err != nil {
		t.Fatalf("EditTool failed to edit in brain directory when jailed: %v", err)
	}

	dataAfter, err := os.ReadFile(notesFile)
	if err != nil || string(dataAfter) != "# Session Notes\n- Initial observation\n- Second observation\n" {
		t.Fatalf("unexpected notes content after edit: %q (err: %v)", string(dataAfter), err)
	}

	// 4. Outside path is still blocked
	outsideFile := filepath.Join(t.TempDir(), "forbidden.txt")
	outsideArgs, _ := json.Marshal(map[string]string{
		"path":    outsideFile,
		"content": "hacked",
	})
	if _, err := writeTool.Execute(context.Background(), outsideArgs, nil); err == nil {
		t.Fatal("expected outside path to be blocked by jail")
	}
}
