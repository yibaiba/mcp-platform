package processtree

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"time"
)

// Host gives Node/Pi the same Windows Job Object ownership as the connector.
func Host(args []string, grace time.Duration) error {
	if len(args) == 0 {
		return fmt.Errorf("stdio-host requires a command after --")
	}
	command := exec.Command(args[0], args[1:]...)
	input, err := command.StdinPipe()
	if err != nil {
		return err
	}
	command.Stdout, command.Stderr = os.Stdout, os.Stderr
	tree, err := Start(command)
	if err != nil {
		return errors.Join(err, input.Close())
	}
	copied := make(chan error, 1)
	exited := make(chan error, 1)
	go func() { _, err := io.Copy(input, os.Stdin); copied <- errors.Join(err, input.Close()) }()
	go func() { exited <- tree.Wait() }()
	select {
	case err := <-copied:
		return errors.Join(err, tree.Stop(grace))
	case err := <-exited:
		return errors.Join(err, tree.Stop(grace))
	}
}
