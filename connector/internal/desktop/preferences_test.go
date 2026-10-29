package desktop

import (
	"io"
	"mcplatform/connector/internal/local/model"
	"os"
	"path/filepath"
	"testing"
)

func TestPreferencesPersistPathsAndRejectInvalidContent(t *testing.T) {
	home := t.TempDir()
	initial, err := LoadPreferences(home)
	if err != nil {
		t.Fatal(err)
	}
	if initial.ConfigPath != filepath.Join(home, ".mcplatform", "connector.json") {
		t.Fatal(initial)
	}
	expected := Preferences{ConfigPath: filepath.Join(home, "device.json"), DataDir: filepath.Join(home, "local"), CAPath: filepath.Join(home, "ca.pem")}
	if err := expected.Save(home); err != nil {
		t.Fatal(err)
	}
	actual, err := LoadPreferences(home)
	if err != nil || actual != expected {
		t.Fatalf("%+v %v", actual, err)
	}
	if err := os.WriteFile(preferencesPath(home), []byte(`{"configPath":"relative.json"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadPreferences(home); err == nil {
		t.Fatal("invalid path accepted")
	}
	if err := os.WriteFile(preferencesPath(home), []byte(`{`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadPreferences(home); err == nil {
		t.Fatal("malformed preferences hidden")
	}
}

func TestUnpairedSessionUsesExistingStoreAndRejectsConcurrentOwner(t *testing.T) {
	home := t.TempDir()
	preferences := Preferences{ConfigPath: filepath.Join(home, "connector.json"), DataDir: filepath.Join(home, "inventory")}
	opts := SessionOptions{Home: home, Preferences: preferences, Diagnostics: io.Discard, Error: func(err error) { t.Error(err) }}
	session, err := OpenSession(t.Context(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if session.Config.DeviceID != "" {
		t.Fatal("unpaired session invented credentials")
	}
	if _, err := session.Runtime.Local.Execute(t.Context(), model.Request{Action: "state"}, false); err != nil {
		t.Fatal(err)
	}
	if second, err := OpenSession(t.Context(), opts); err == nil {
		second.Runtime.Close()
		t.Fatal("concurrent owner admitted")
	}
	if err := session.Runtime.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenSession(t.Context(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if err := reopened.Runtime.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestInvalidSkillPaths(t *testing.T) {
	for _, path := range []string{"", ".", "../secret", "a/../secret", "/tmp/file", `a\b`, "a//b"} {
		if validSkillPath(path) {
			t.Errorf("accepted %q", path)
		}
	}
	for _, path := range []string{"SKILL.md", "notes/中文.md"} {
		if !validSkillPath(path) {
			t.Errorf("rejected %q", path)
		}
	}
}
