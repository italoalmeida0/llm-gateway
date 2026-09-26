//go:build darwin

package proctable

import (
	"encoding/binary"
	"strings"
	"syscall"
)

// listProcs on macOS/BSD: there is no /proc, but the kernel exposes the
// process table through sysctl (kern.proc.all) — the same source ps(1)
// itself reads. Extracted from unish (owner-sanctioned): the kinfo_proc
// ABI parsing is battle-tested there.
//
// kinfo_proc is a fixed 648-byte struct on 64-bit Darwin: an extern_proc
// (struct proc) followed by an eproc. Only a few offsets are needed and
// they are stable ABI (defined in <sys/sysctl.h> / <sys/proc.h>).
const kinfoProcSize = 648

// Offsets within one kinfo_proc record (64-bit Darwin).
const (
	offPFlag  = 32  // extern_proc.p_flag (int32)
	offPStat  = 36  // extern_proc.p_stat (char)
	offPPid   = 40  // extern_proc.p_pid (pid_t)
	offComm   = 243 // extern_proc.p_comm (char[17])
	offEproc  = 296 // start of eproc
	offEPpid  = 296 // eproc.e_ppid (pid_t)
)

func listProcs() ([]Proc, error) {
	raw, err := syscall.Sysctl("kern.proc.all")
	if err != nil {
		return nil, err
	}
	buf := []byte(raw)
	var out []Proc
	for off := 0; off+kinfoProcSize <= len(buf); off += kinfoProcSize {
		kp := buf[off : off+kinfoProcSize]
		pid := int(int32(binary.LittleEndian.Uint32(kp[offPPid : offPPid+4])))
		if pid <= 0 {
			continue
		}
		ppid := int(int32(binary.LittleEndian.Uint32(kp[offEPpid : offEPpid+4])))
		out = append(out, Proc{
			PID:  pid,
			PPID: ppid,
			Stat: darwinStat(kp[offPStat]),
			Cmd:  cstr(kp[offComm : offComm+17]),
		})
	}
	return out, nil
}

// bootTimeSec reads sysctl kern.boottime (struct timeval: first 8 bytes
// are the epoch seconds on 64-bit Darwin).
func bootTimeSec() int64 {
	raw, err := syscall.Sysctl("kern.boottime")
	if err != nil || len(raw) < 8 {
		return 0
	}
	secs := int64(binary.LittleEndian.Uint64([]byte(raw)[:8]))
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
	if i := strings.IndexByte(string(b), 0); i >= 0 {
		b = b[:i]
	}
	return string(b)
}

// darwinStat maps the BSD process state byte to the ps letter.
func darwinStat(s byte) string {
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
