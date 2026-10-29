package bundles

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRuntimeConstraintsUseActualInterpreterAndRejectUnverifiableLaunch(t *testing.T) {
	command, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("runtime verification tests require Node.js:", err)
	}
	store := &Store{Dir: t.TempDir()}
	input := fixture(t, "server.js", 0600)
	if _, err := store.Install(raw(t, input)); err != nil {
		t.Fatal(err)
	}
	input.Config = raw(t, map[string]any{"command": command, "cwd": filepath.Join(store.Dir, "packages", input.SHA256)})
	for _, tc := range []struct{ constraint, code string }{
		{">=22 <99", ""}, {">=999", "MCPB_RUNTIME_INCOMPATIBLE"}, {"^999.1.0", "MCPB_RUNTIME_INCOMPATIBLE"},
		{">=999 || >=22 <99", ""}, {"garbage", "MCPB_RUNTIME_RANGE"},
	} {
		manifest := map[string]any{"server": map[string]string{"type": "node"}, "compatibility": map[string]any{"runtimes": map[string]string{"node": tc.constraint}}}
		if err := os.WriteFile(filepath.Join(store.Dir, "packages", input.SHA256, "manifest.json"), raw(t, manifest), 0600); err != nil {
			t.Fatal(err)
		}
		err := store.checkRuntime(context.Background(), input)
		if (tc.code == "" && err != nil) || (tc.code != "" && (err == nil || !strings.Contains(err.Error(), tc.code))) {
			t.Fatalf("%s: %v", tc.constraint, err)
		}
	}
	input.Config = json.RawMessage(`{"command":"npx"}`)
	if err := store.checkRuntime(context.Background(), input); err == nil || !strings.Contains(err.Error(), "UNVERIFIABLE") {
		t.Fatal(err)
	}
}
func TestDescriptorPinsEncryptedConfigurationAndDoesNotExposeSecrets(t *testing.T) {
	store := &Store{Dir: t.TempDir()}
	input := fixture(t, "server.js", 0600)
	input.Config = raw(t, map[string]any{"command": "node", "cwd": filepath.Join(store.Dir, "packages", input.SHA256), "env": map[string]string{"TOKEN": "local-private"}})
	if _, err := store.Install(raw(t, input)); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	descriptor, err := store.Descriptor(input.SHA256, executable)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw(t, descriptor)), "local-private") {
		t.Fatal("secret in descriptor")
	}
	args := descriptor["args"].([]string)
	revision := args[len(args)-1]
	if _, err := store.launch(input.SHA256, revision); err != nil {
		t.Fatal(err)
	}
	if err := store.RemoveConfiguration(input.SHA256, "stale"); err == nil {
		t.Fatal("stale removal accepted")
	}
	if err := store.RemoveConfiguration(input.SHA256, revision); err != nil {
		t.Fatal(err)
	}
	if _, err := store.launch(input.SHA256, revision); err == nil {
		t.Fatal("removed configuration still launched")
	}
	if _, err := os.Stat(filepath.Join(store.Dir, "packages", input.SHA256, "server.js")); err != nil {
		t.Fatal("shared package file removed", err)
	}
}

func TestRemovalValidatesBeforeCleanupAndRetainsConfigurationOnCleanupFailure(t *testing.T) {
	store := &Store{Dir: t.TempDir()}
	input := fixture(t, "server.js", 0600)
	input.Config = raw(t, map[string]any{"command": "node", "cwd": filepath.Join(store.Dir, "packages", input.SHA256)})
	if _, err := store.Install(raw(t, input)); err != nil {
		t.Fatal(err)
	}
	revision, err := store.configurationRevision(input.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	cleanupError := errors.New("runtime cleanup failed")
	calls := 0
	cleanup := func() error { calls++; return cleanupError }
	if err = store.RemoveConfigurationAfterValidation(input.SHA256, "stale", cleanup); err == nil || calls != 0 {
		t.Fatal("stale revision ran cleanup:", err, calls)
	}
	if err = store.RemoveConfigurationAfterValidation(input.SHA256, revision, cleanup); !errors.Is(err, cleanupError) || calls != 1 {
		t.Fatal("cleanup failure lost:", err, calls)
	}
	if _, err = store.ConfigurationAt(input.SHA256, revision); err != nil {
		t.Fatal("failed cleanup removed configuration:", err)
	}
	if err = store.RemoveConfiguration(input.SHA256, revision); err != nil {
		t.Fatal(err)
	}
}
