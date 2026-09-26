//go:build windows

package runner

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os/exec"
	"time"
	"unsafe"
)

// Native JOBOBJECT_BASIC_ACCOUNTING_INFORMATION layout (winnt.h).
type jobAccounting struct {
	TotalUserTime, TotalKernelTime, PeriodUserTime, PeriodKernelTime               int64
	TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses uint32
}

// The runner owns the job handle, not the daemon. Runner death closes it;
// daemon replacement leaves the runner and its command tree intact.
func ownCommand(cmd *exec.Cmd) (kill func() error, close func(), err error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, nil, err
	}
	cleanup := func() { _ = windows.CloseHandle(job) }
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	_, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	p, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	err = windows.AssignProcessToJobObject(job, p)
	_ = windows.CloseHandle(p)
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	return func() error {
		if err := windows.TerminateJobObject(job, 1); err != nil {
			return err
		}
		deadline := time.Now().Add(10 * time.Second)
		for {
			var accounting jobAccounting
			err := windows.QueryInformationJobObject(job, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&accounting)), uint32(unsafe.Sizeof(accounting)), nil)
			if err != nil {
				return err
			}
			if accounting.ActiveProcesses == 0 {
				return nil
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("command job did not drain")
			}
			time.Sleep(20 * time.Millisecond)
		}
	}, cleanup, nil
}
