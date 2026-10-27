//go:build !windows

package processtree

import (
	"errors"
	"os/exec"
	"syscall"
	"time"
)

type platformTree struct{}

func prepare(command *exec.Cmd) (*platformTree, error) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return &platformTree{}, nil
}
func (*platformTree) attach(int) error { return nil }
func (*platformTree) close() error     { return nil }
func (*platformTree) stop(pid int, grace time.Duration) error {
	if err := syscall.Kill(-pid, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(-pid, 0); errors.Is(err, syscall.ESRCH) {
			return nil
		} else if err != nil {
			return err
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := syscall.Kill(-pid, syscall.SIGKILL); !errors.Is(err, syscall.ESRCH) {
		return err
	}
	return nil
}
