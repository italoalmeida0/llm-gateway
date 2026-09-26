//go:build windows

package proctable

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

var (
	modKernel32          = syscall.NewLazyDLL("kernel32.dll")
	procCreateSnapshot   = modKernel32.NewProc("CreateToolhelp32Snapshot")
	procProcess32First   = modKernel32.NewProc("Process32FirstW")
	procProcess32Next    = modKernel32.NewProc("Process32NextW")
	procCloseHandle      = modKernel32.NewProc("CloseHandle")
)

const (
	th32csSnapProcess    = 0x00000002
	invalidHandleValue   = ^uintptr(0)
)

type processEntry32 struct {
	size              uint32
	cntUsage          uint32
	processID         uint32
	defaultHeapID     uintptr
	moduleID          uint32
	cntThreads        uint32
	parentProcessID   uint32
	priClassBase      int32
	flags             uint32
	exeFile           [260]uint16
}

// listProcs enumerates the Windows process table (Toolhelp32 snapshot —
// extracted from the unish project, owner-sanctioned).
func listProcs() ([]Proc, error) {
	snap, _, _ := procCreateSnapshot.Call(uintptr(th32csSnapProcess), 0)
	if snap == invalidHandleValue {
		return nil, fmt.Errorf("process snapshot failed")
	}
	defer procCloseHandle.Call(snap)
	var out []Proc
	var pe processEntry32
	pe.size = uint32(unsafe.Sizeof(pe))
	r, _, _ := procProcess32First.Call(snap, uintptr(unsafe.Pointer(&pe)))
	for r != 0 {
		out = append(out, Proc{
			PID:  int(pe.processID),
			PPID: int(pe.parentProcessID),
			Stat: "R",
			Cmd:  syscall.UTF16ToString(pe.exeFile[:]),
		})
		r, _, _ = procProcess32Next.Call(snap, uintptr(unsafe.Pointer(&pe)))
	}
	return out, nil
}

// bootTimeSec is unavailable without WMI on Windows (identity checks use
// the PID + start data from the state file instead).
func bootTimeSec() int64 { return 0 }

// signalPID kills one process (Windows has no POSIX signals).
func signalPID(pid int, _ int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}
