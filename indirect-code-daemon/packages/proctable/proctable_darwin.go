//go:build darwin

package proctable

import (
	"syscall"

	"golang.org/x/sys/unix"
)

// listProcs on macOS/BSD: there is no /proc, but the kernel exposes the
// process table through sysctl (kern.proc.all) — the source ps(1) itself
// reads. Parsing goes through x/sys/unix's typed KinfoProc (no magic byte
// offsets, no cgo): the struct layout is maintained by the Go team, so
// this cannot drift the way a hand-rolled offset table can.
func listProcs() ([]Proc, error) {
	kinfos, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return nil, err
	}
	out := make([]Proc, 0, len(kinfos))
	for i := range kinfos {
		kp := &kinfos[i]
		pid := int(kp.Proc.P_pid)
		if pid <= 0 {
			continue
		}
		out = append(out, Proc{
			PID:  pid,
			PPID: int(kp.Eproc.Ppid),
			Stat: darwinStat(kp.Proc.P_stat),
			Cmd:  cstr(kp.Proc.P_comm[:]),
		})
	}
	return out, nil
}

// bootTimeSec reads sysctl kern.boottime (struct timeval: the first 8
// bytes are the epoch seconds on 64-bit Darwin).
func bootTimeSec() int64 {
	raw, err := unix.SysctlRaw("kern.boottime")
	if err != nil || len(raw) < 8 {
		return 0
	}
	secs := int64(uint64(raw[0]) | uint64(raw[1])<<8 | uint64(raw[2])<<16 | uint64(raw[3])<<24 |
		uint64(raw[4])<<32 | uint64(raw[5])<<40 | uint64(raw[6])<<48 | uint64(raw[7])<<56)
	if secs <= 0 {
		return 0
	}
	return secs
}

// signalPID sends sig to one pid (0 = existence probe).
func signalPID(pid int, sig int) error {
	return syscall.Kill(pid, syscall.Signal(sig))
}

// cstr reads a NUL-terminated string from a fixed-size field.
func cstr(b []byte) string {
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return string(b)
}

// darwinStat maps the BSD process state byte to the ps letter.
func darwinStat(s int8) string {
	switch s {
	case 1:
		return "I" // idle
	case 2:
		return "R" // running
	case 3:
		return "S" // sleeping
	case 4:
		return "T" // stopped
	case 5:
		return "Z" // zombie
	}
	return "?"
}
