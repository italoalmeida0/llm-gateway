//go:build windows

package tools

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

func setProcessGroup(cmd *exec.Cmd) {
	// Cancel must terminate the tree BEFORE the root disappears. The default
	// CommandContext cancellation kills only the root and orphans descendants.
	var once sync.Once
	var stopErr error
	cmd.Cancel = func() error {
		once.Do(func() {
			if cmd.Process == nil {
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			stopErr = exec.CommandContext(ctx, "taskkill", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F").Run()
			if stopErr != nil {
				stopErr = cmd.Process.Kill()
			}
		})
		return stopErr
	}
}

// isExecutableFile reports whether path can be executed. Windows has no
// unix exec bits: any existing non-directory with an executable extension
// (.exe/.bat/.cmd/.com, plus extensionless files like the managed unish
// copy without its suffix) counts. Without this, every probe on Windows
// fails and the daemon re-downloads unish/python on every start.
func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".exe", ".bat", ".cmd", ".com", "":
		return true
	default:
		return false
	}
}

func killProcessGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	if cmd.Cancel != nil {
		_ = cmd.Cancel()
	} else {
		_ = cmd.Process.Kill()
	}
}
