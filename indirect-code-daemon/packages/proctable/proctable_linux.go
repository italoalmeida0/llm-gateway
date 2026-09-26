//go:build linux

package proctable

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// listProcs reads /proc — the same source ps(1) reads on Linux.
func listProcs() ([]Proc, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	var out []Proc
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		p := Proc{PID: pid}
		if data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid)); err == nil {
			s := string(data)
			if ri := strings.LastIndexByte(s, ')'); ri > 0 {
				if rest := strings.Fields(s[ri+1:]); len(rest) > 2 {
					p.Stat = rest[0]
					p.PPID, _ = strconv.Atoi(rest[1])
				}
			}
		}
		if data, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid)); err == nil && len(data) > 0 {
			parts := strings.Split(string(data), "\x00")
			var cmd []string
			for _, x := range parts {
				if x != "" {
					cmd = append(cmd, x)
				}
			}
			p.Cmd = strings.Join(cmd, " ")
		} else if data, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid)); err == nil {
			p.Cmd = "[" + strings.TrimSpace(string(data)) + "]"
		}
		if p.Cmd == "" {
			continue
		}
		out = append(out, p)
	}
	return out, nil
}

// bootTimeSec reads /proc/stat's btime.
func bootTimeSec() int64 {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "btime ") {
			if v, err := strconv.ParseInt(strings.Fields(line)[1], 10, 64); err == nil {
				return v
			}
		}
	}
	return 0
}

// signalPID sends sig to one pid (0 = existence probe).
func signalPID(pid int, sig int) error {
	return syscall.Kill(pid, syscall.Signal(sig))
}
