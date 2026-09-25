package tools

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"llm-gateway/indirect-code-daemon/packages/processutil"
	"llm-gateway/indirect-code-daemon/packages/provider"
)

func TestUnishExternalChild(t *testing.T) {
	if marker := os.Getenv("UNISH_CHILD_MARKER"); marker != "" {
		if err := os.WriteFile(marker, []byte(strconv.Itoa(os.Getpid())), 0600); err != nil {
			os.Exit(2)
		}
		time.Sleep(time.Minute)
		os.Exit(0)
	}
}

// CI builds a pinned unish on every OS. Local runs opt in with the same binary.
func TestUnishToolBoundary(t *testing.T) {
	bin := os.Getenv("UNISH_TEST_BINARY")
	if bin == "" {
		t.Skip("set UNISH_TEST_BINARY to exercise the pinned unish executable")
	}
	if !probeShellPath(bin, "-c") {
		t.Fatal("configured unish cannot execute commands")
	}
	SetShellOverride(bin, "-c", true)
	t.Cleanup(ClearShellOverride)
	for _, tc := range []struct {
		name, command, want string
		failed              bool
	}{
		{"quoted paths and pipeline", `mkdir 'space dir'; printf 'alpha\nbeta\n' > 'space dir/ação.txt'; cat 'space dir/ação.txt' | grep beta`, "beta\n", false},
		{"bash arrays", `items=(one two); [[ ${#items[@]} -eq 2 ]] && printf '%s\n' "${items[1]}"`, "two\n", false},
		{"stderr and exit status", `printf 'diagnostic\n' >&2; exit 7`, "diagnostic\n", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tool := &BashTool{CWD: t.TempDir(), LogDir: t.TempDir()}
			res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"command": tc.command}), nil)
			if err != nil {
				t.Fatal(err)
			}
			text := res.Content[0].(provider.TextBlock).Text
			if res.IsError != tc.failed || !strings.Contains(text, tc.want) {
				t.Fatalf("unexpected result: %+v", res)
			}
			if tc.failed && !strings.Contains(text, "Command exited with code 7") {
				t.Fatal("exit status lost")
			}
		})
	}
	t.Run("long line remains readable", func(t *testing.T) {
		dir := t.TempDir()
		payload := strings.Repeat("x", 128*1024) + "TAIL\n"
		if err := os.WriteFile(filepath.Join(dir, "large.txt"), []byte(payload), 0600); err != nil {
			t.Fatal(err)
		}
		tool := &BashTool{CWD: dir, LogDir: dir}
		res, err := tool.Execute(context.Background(), mustJSON(t, map[string]any{"command": "cat large.txt"}), nil)
		if err != nil || res.IsError {
			t.Fatalf("long line: %v %+v", err, res)
		}
		path, _ := res.Details.(map[string]any)["full_output_path"].(string)
		full, err := os.ReadFile(path)
		if err != nil || string(full) != payload {
			t.Fatalf("full output lost: %v, bytes=%d", err, len(full))
		}
		if !strings.Contains(res.Content[0].(provider.TextBlock).Text, "TAIL") {
			t.Fatal("tail lost")
		}
	})
	t.Run("cancel external descendant", func(t *testing.T) {
		dir := t.TempDir()
		marker := filepath.Join(dir, "child.pid")
		t.Setenv("UNISH_CHILD_MARKER", marker)
		self, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		// Quoted forward slashes work for both Windows drive paths and Unix paths.
		quoted := "'" + strings.ReplaceAll(filepath.ToSlash(self), "'", "'\"'\"'") + "'"
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		done := make(chan error, 1)
		tool := &BashTool{CWD: dir, LogDir: dir}
		args := mustJSON(t, map[string]any{"command": quoted + " -test.run=^TestUnishExternalChild$; echo child-finished"})
		go func() {
			_, err := tool.Execute(ctx, args, nil)
			done <- err
		}()
		pid := 0
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			raw, _ := os.ReadFile(marker)
			pid, _ = strconv.Atoi(string(raw))
			if pid > 0 {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		if pid == 0 {
			t.Fatal("external child did not start")
		}
		t.Cleanup(func() {
			if p, err := os.FindProcess(pid); err == nil {
				_ = p.Kill()
			}
		})
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatal("tool did not stop")
		}
		deadline = time.Now().Add(5 * time.Second)
		for processutil.Alive(pid) && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		if processutil.Alive(pid) {
			t.Fatal("cancelling the tool left an external child alive")
		}
	})
}
