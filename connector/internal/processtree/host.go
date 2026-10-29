package processtree

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

// Host gives Node/Pi the same Windows Job Object ownership as the connector.
func Host(args []string, grace time.Duration) error {
	if len(args) == 0 {
		return fmt.Errorf("stdio-host requires a command after --")
	}
	return HostCommand(exec.Command(args[0], args[1:]...), grace)
}

func HostCommand(command *exec.Cmd, grace time.Duration) error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	input, err := command.StdinPipe()
	if err != nil {
		return err
	}
	if command.Stdout == nil {
		command.Stdout = os.Stdout
	}
	if command.Stderr == nil {
		command.Stderr = os.Stderr
	}
	tree, err := Start(command)
	if err != nil {
		return errors.Join(err, input.Close())
	}
	copied := make(chan error, 1)
	exited := make(chan error, 1)
	go func() { _, err := io.Copy(input, os.Stdin); copied <- errors.Join(err, input.Close()) }()
	go func() { exited <- tree.Wait() }()
	select {
	case <-ctx.Done():
		return tree.Stop(grace)
	case err := <-copied:
		return errors.Join(err, tree.Stop(grace))
	case err := <-exited:
		return errors.Join(err, tree.Stop(grace))
	}
}
