package bundles

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/Masterminds/semver/v3"
)

type runtimeLaunch struct {
	Command string            `json:"command"`
	Cwd     string            `json:"cwd"`
	Env     map[string]string `json:"env"`
}

type runtimeManifest struct {
	Server struct {
		Type string `json:"type"`
	} `json:"server"`
	Compatibility struct {
		Runtimes map[string]string `json:"runtimes"`
	} `json:"compatibility"`
}

// Probe only runs the declared interpreter's version command, never package tools.
func ProbeRuntime(ctx context.Context, launch runtimeLaunch) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, launch.Command, "--version")
	command.Dir = launch.Cwd
	command.Env = os.Environ()
	for key, value := range launch.Env {
		command.Env = append(command.Env, key+"="+value)
	}
	output, err := command.Output()
	if ctx.Err() != nil {
		return "", fmt.Errorf("MCPB_RUNTIME_TIMEOUT: runtime version probe timed out")
	}
	if err != nil {
		return "", fmt.Errorf("MCPB_RUNTIME_UNAVAILABLE: runtime version probe failed (%T)", err)
	}
	version := strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(string(output)), "Python "), "v")
	if !regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`).MatchString(version) {
		return "", fmt.Errorf("MCPB_RUNTIME_VERSION: interpreter did not return a valid version")
	}
	return version, nil
}

func (s *Store) checkRuntime(ctx context.Context, input Install) error {
	data, err := os.ReadFile(filepath.Join(s.Dir, "packages", input.SHA256, "manifest.json"))
	if err != nil {
		return err
	}
	var manifest runtimeManifest
	if err = json.Unmarshal(data, &manifest); err != nil {
		return err
	}
	var config runtimeLaunch
	config.Cwd = filepath.Join(s.Dir, "packages", input.SHA256)
	config.Command = input.RuntimeCommand
	config.Env = input.RuntimeEnv
	if len(input.Config) > 0 {
		if err = json.Unmarshal(input.Config, &config); err != nil {
			return err
		}
	}
	for runtime, constraint := range manifest.Compatibility.Runtimes {
		if runtime != "node" && runtime != "python" {
			return fmt.Errorf("MCPB_RUNTIME_UNSUPPORTED: unknown runtime constraint")
		}
		if runtime != manifest.Server.Type {
			return fmt.Errorf("MCPB_RUNTIME_UNVERIFIABLE: declared runtime differs from launch runtime")
		}
		name := strings.TrimSuffix(strings.ToLower(filepath.Base(config.Command)), ".exe")
		if (runtime == "node" && name != "node" && name != "nodejs") || (runtime == "python" && !regexp.MustCompile(`^python(?:[23](?:\.[0-9]+)?)?$`).MatchString(name)) {
			return fmt.Errorf("MCPB_RUNTIME_UNVERIFIABLE: use an explicit interpreter to verify its constraint")
		}
		required, err := semver.NewConstraint(constraint)
		if err != nil {
			return fmt.Errorf("MCPB_RUNTIME_RANGE: invalid runtime version constraint")
		}
		version, err := ProbeRuntime(ctx, config)
		if err != nil {
			return err
		}
		actual, err := semver.StrictNewVersion(version)
		if err != nil || !required.Check(actual) {
			return fmt.Errorf("MCPB_RUNTIME_INCOMPATIBLE: %s %s does not satisfy %s", runtime, version, constraint)
		}
	}
	return nil
}
