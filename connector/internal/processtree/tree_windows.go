package processtree

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os/exec"
	"syscall"
	"time"
	"unsafe"
)

type platformTree struct{ job windows.Handle }

// JOBOBJECT_BASIC_ACCOUNTING_INFORMATION layout from Win32; x/sys does not expose this record.
type jobAccounting struct {
	TotalUserTime, TotalKernelTime                                                 int64
	ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime                             int64
	TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses uint32
}

func prepare(command *exec.Cmd) (*platformTree, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_SUSPENDED | windows.CREATE_NEW_PROCESS_GROUP}
	return &platformTree{job: job}, nil
}
func (tree *platformTree) attach(pid int) error {
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|windows.PROCESS_SUSPEND_RESUME, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(process)
	if err := windows.AssignProcessToJobObject(tree.job, process); err != nil {
		return err
	}
	status, _, _ := windows.NewLazySystemDLL("ntdll.dll").NewProc("NtResumeProcess").Call(uintptr(process))
	if status != 0 {
		return fmt.Errorf("NtResumeProcess failed: NTSTATUS 0x%x", status)
	}
	return nil
}
func (tree *platformTree) stop(pid int, grace time.Duration) error {
	// stdin is closed by the MCP session before the grace period starts.
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		accounting := jobAccounting{}
		if err := windows.QueryInformationJobObject(tree.job, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&accounting)), uint32(unsafe.Sizeof(accounting)), nil); err != nil {
			return err
		}
		if accounting.ActiveProcesses == 0 {
			return nil
		}
		time.Sleep(20 * time.Millisecond)
	}
	return windows.TerminateJobObject(tree.job, 1)
}
func (tree *platformTree) close() error { return windows.CloseHandle(tree.job) }
