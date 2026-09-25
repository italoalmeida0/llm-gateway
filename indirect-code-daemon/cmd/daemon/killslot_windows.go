//go:build windows

package main

import (
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

// killSlotProcessesByDir snapshots processes via Toolhelp32 (kernel32,
// stdlib only — same pattern as unish sysinfo_windows.go) and kills
// those whose executable lives inside slotDir. Catches app children
// (no pidfile). Access-denied processes are skipped (their image path
// can't be read, but they also can't be ours without admin rights).
func killSlotProcessesByDir(slotDir string, ownPid int, kill func(pid int, why string)) {
	absDir, err := filepath.Abs(slotDir)
	if err != nil {
		return
	}
	needle := strings.ToLower(absDir)
	snap, _, _ := winProcCreateSnapshot.Call(uintptr(winTh32csSnapProcess), 0)
	if snap == winInvalidHandleValue {
		return
	}
	defer winProcCloseHandle.Call(snap)
	var pe winProcessEntry32
	pe.size = uint32(unsafe.Sizeof(pe))
	r, _, _ := winProcProcess32First.Call(snap, uintptr(unsafe.Pointer(&pe)))
	for r != 0 {
		pid := int(pe.processID)
		if pid > 0 && pid != ownPid {
			if img := winProcessImagePath(uint32(pid)); img != "" {
				low := strings.ToLower(img)
				if low == needle || strings.HasPrefix(low, needle+"\\") {
					kill(pid, "exe in slot")
				}
			}
		}
		r, _, _ = winProcProcess32Next.Call(snap, uintptr(unsafe.Pointer(&pe)))
	}
}

const (
	winTh32csSnapProcess  = 0x00000002
	winMaxPath            = 260
	winInvalidHandleValue = ^uintptr(0)
)

type winProcessEntry32 struct {
	size            uint32
	usage           uint32
	processID       uint32
	defaultHeapID   uintptr
	moduleID        uint32
	threads         uint32
	parentProcessID uint32
	priClassBase    int32
	flags           uint32
	exeFile         [winMaxPath]uint16
}

var (
	winModKernel32         = syscall.NewLazyDLL("kernel32.dll")
	winProcCreateSnapshot  = winModKernel32.NewProc("CreateToolhelp32Snapshot")
	winProcProcess32First  = winModKernel32.NewProc("Process32FirstW")
	winProcProcess32Next   = winModKernel32.NewProc("Process32NextW")
	winProcCloseHandle     = winModKernel32.NewProc("CloseHandle")
	winProcOpenProcess     = winModKernel32.NewProc("OpenProcess")
	winProcQueryImageName  = winModKernel32.NewProc("QueryFullProcessImageNameW")
)

// winProcessImagePath returns the full exe path of pid ("" on any error:
// access denied, exited, protected).
func winProcessImagePath(pid uint32) string {
	const processQueryLimitedInfo = 0x1000
	h, _, _ := winProcOpenProcess.Call(uintptr(processQueryLimitedInfo), 0, uintptr(pid))
	if h == 0 {
		return ""
	}
	defer winProcCloseHandle.Call(h)
	var buf [winMaxPath * 2]uint16
	size := uint32(len(buf))
	r, _, _ := winProcQueryImageName.Call(h, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if r == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf[:size])
}
