//go:build windows

package tools

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func setProcessGroup(_ *exec.Cmd) {}

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
	_ = cmd.Process.Kill()
	time.AfterFunc(3*time.Second, func() {
		_ = cmd.Process.Kill()
	})
}
