package processtree

import (
	"errors"
	"os/exec"
	"sync"
	"time"
)

type Tree struct {
	Command  *exec.Cmd
	platform *platformTree
	done     chan struct{}
	waitErr  error
	stopOnce sync.Once
	stopErr  error
}

func Start(command *exec.Cmd) (*Tree, error) {
	platform, err := prepare(command)
	if err != nil {
		return nil, err
	}
	if err := command.Start(); err != nil {
		return nil, errors.Join(err, platform.close())
	}
	if err := platform.attach(command.Process.Pid); err != nil {
		killErr := command.Process.Kill()
		_ = command.Wait()
		return nil, errors.Join(err, killErr, platform.close())
	}
	tree := &Tree{Command: command, platform: platform, done: make(chan struct{})}
	go func() { tree.waitErr = command.Wait(); close(tree.done) }()
	return tree, nil
}

func (tree *Tree) Stop(grace time.Duration) error {
	if tree == nil {
		return nil
	}
	tree.stopOnce.Do(func() {
		err := tree.platform.stop(tree.Command.Process.Pid, grace)
		<-tree.done
		tree.stopErr = errors.Join(err, tree.platform.close())
	})
	return tree.stopErr
}

func (tree *Tree) Wait() error { <-tree.done; return tree.waitErr }
