package bundles

import (
	"encoding/json"
	"flag"
	"fmt"
	"mcplatform/connector/internal/network"
	"mcplatform/connector/internal/processtree"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// Stdio runs the encrypted local configuration without exposing it in client settings.
// Both the CLI and desktop executable handle this before starting their normal UI/runtime.
func Stdio(args []string) error {
	flags := flag.NewFlagSet("bundle-stdio", flag.ContinueOnError)
	dir := flags.String("data-dir", "", "absolute bundle store directory")
	hash := flags.String("sha256", "", "bundle digest")
	revision := flags.String("revision", "", "expected configuration revision")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if !filepath.IsAbs(*dir) || !hashPattern.MatchString(*hash) || *revision == "" || flags.NArg() != 0 {
		return fmt.Errorf("bundle-stdio requires an absolute data-dir, sha256 and revision")
	}
	store := &Store{Dir: *dir}
	config, err := store.launch(*hash, *revision)
	if err != nil {
		return err
	}
	settings, err := network.Open(filepath.Dir(*dir))
	if err != nil {
		return err
	}
	declaration, _, err := network.Declaration(config)
	if err != nil {
		return err
	}
	snapshot, _ := settings.Snapshot()
	prepared, err := network.Prepare(declaration, snapshot)
	if err != nil {
		return err
	}
	command := exec.Command(prepared.Command, prepared.Args...)
	command.Dir = prepared.Cwd
	command.Env = os.Environ()
	for key, value := range prepared.Env {
		command.Env = append(command.Env, key+"="+value)
	}
	return processtree.HostCommand(command, 5*time.Second)
}
func (s *Store) launch(hash, revision string) (network.Command, error) {
	var command network.Command
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := s.configuration(hash, revision)
	if err != nil {
		return command, err
	}
	if err = json.Unmarshal(raw, &command); err != nil {
		return command, err
	}
	return command, nil
}

func (s *Store) Descriptor(hash, executable string) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !hashPattern.MatchString(hash) || !filepath.IsAbs(executable) {
		return nil, fmt.Errorf("invalid bundle descriptor")
	}
	revision, err := s.configurationRevision(hash)
	if err != nil {
		return nil, err
	}
	if revision == "" {
		return nil, fmt.Errorf("bundle configuration missing")
	}
	return map[string]any{"command": executable, "args": []string{"bundle-stdio", "--data-dir", s.Dir, "--sha256", hash, "--revision", revision}}, nil
}

// RemoveConfiguration retains immutable package files: platform installations may share them.
func (s *Store) RemoveConfiguration(hash, revision string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !hashPattern.MatchString(hash) || revision == "" {
		return fmt.Errorf("bundle digest and revision required")
	}
	current, err := s.configurationRevision(hash)
	if err != nil {
		return err
	}
	if current != revision {
		return fmt.Errorf("MCPB configuration changed; reload before removing")
	}
	return os.Remove(filepath.Join(s.Dir, hash+".enc"))
}
