//go:build windows

package runner

import (
	"syscall"
)

// Windows UTF-8 defaults (extracted from unish, owner-sanctioned): the
// classic agent papercut is "UnicodeEncodeError: 'charmap' codec can't
// encode ..." when a child (python, node, ...) prints unicode under a
// cp1252/cp850 console. Two layers:
//
//  1. Our own console: SetConsoleOutputCP(CP_UTF8) so the runner itself
//     renders/accepts UTF-8.
//  2. Env defaults for the command (and grandchildren): UTF-8 stdio for
//     python unless the user already decided otherwise — explicit user
//     settings ALWAYS win.

var (
	modKernel32UTF8  = syscall.NewLazyDLL("kernel32.dll")
	procSetOutputCP  = modKernel32UTF8.NewProc("SetConsoleOutputCP")
	procSetConsoleCP = modKernel32UTF8.NewProc("SetConsoleCP")
)

const cpUTF8 = 65001

func init() {
	// Best effort: never fail startup because of this.
	_, _, _ = procSetOutputCP.Call(uintptr(cpUTF8))
	_, _, _ = procSetConsoleCP.Call(uintptr(cpUTF8))
}

// utf8Env adds UTF-8 stdio defaults the child env does not already set.
func utf8Env(env []string) []string {
	defaults := map[string]string{
		"PYTHONIOENCODING": "utf-8",
		"PYTHONUTF8":       "1",
	}
	for _, kv := range env {
		for k := range defaults {
			if len(kv) > len(k) && kv[:len(k)+1] == k+"=" {
				delete(defaults, k) // explicit user setting wins
			}
		}
	}
	for k, v := range defaults {
		env = append(env, k+"="+v)
	}
	return env
}
