package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRePairPreservesFieldsAndReplacesOldToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "connector.json")
	original := `{"server":"https://example.com","deviceId":"device","token":"legacy","localDataDir":"/local","skillRoots":{"one":"/skills"},"artifactRoots":{"two":"/artifacts"},"future":{"enabled":true}}`
	if err := os.WriteFile(path, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, fields, err := ReadForRePair(path)
	if err != nil {
		t.Fatal(err)
	}
	cfg.DeviceSecret = strings.Repeat("A", 43)
	cfg.CredentialVersion = 2
	if err = ReplaceCredentials(path, fields, cfg); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var saved map[string]json.RawMessage
	if err = json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if _, ok := saved["token"]; ok {
		t.Fatal("legacy token retained")
	}
	for _, key := range []string{"future", "localDataDir", "skillRoots", "artifactRoots"} {
		if string(saved[key]) != string(fields[key]) { // Compare decoded values because indentation may change.
			var want, got any
			json.Unmarshal(fields[key], &want)
			json.Unmarshal(saved[key], &got)
			a, _ := json.Marshal(want)
			b, _ := json.Marshal(got)
			if string(a) != string(b) {
				t.Fatalf("lost %s", key)
			}
		}
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("permissions: %v", err)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Fatal("staging file leaked")
	}
}
func TestAtomicRePairFailurePreservesExistingTarget(t *testing.T) {
	path := filepath.Join(t.TempDir(), "connector.json")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(path, "keep")
	if err := os.WriteFile(marker, []byte("unchanged"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := ReplaceCredentials(path, nil, Config{}); err == nil {
		t.Fatal("expected rename failure")
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "unchanged" {
		t.Fatal("target changed on failure")
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Fatal("staging file leaked after failure")
	}
}
