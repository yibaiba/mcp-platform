package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestRePairSaveFailureReportsRecoveryAndCanRetry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "connector.json")
	deviceID := "11111111-1111-4111-8111-111111111111"
	secret := strings.Repeat("A", 43)
	var failSave atomic.Bool
	failSave.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if failSave.Load() {
			if err := os.Remove(path); err != nil {
				t.Error(err)
			}
			if err := os.Mkdir(path, 0700); err != nil {
				t.Error(err)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte(`{"deviceId":"` + deviceID + `","deviceSecret":"` + secret + `","credentialVersion":2}`))
	}))
	defer server.Close()
	original := `{"server":"` + server.URL + `/","deviceId":"` + deviceID + `","token":"old","custom":true}`
	writeConfig := func() {
		t.Helper()
		if err := os.WriteFile(path, []byte(original), 0600); err != nil {
			t.Fatal(err)
		}
	}
	writeConfig()
	run := func() error {
		t.Helper()
		reader, writer, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		previous := os.Stdin
		os.Stdin = reader
		defer func() { os.Stdin = previous; reader.Close() }()
		writer.Write([]byte("new-one-use-code\n"))
		writer.Close()
		return pairingCommand(server.Client(), repairOptions{Action: "re-pair", Path: path})
	}
	err := run()
	if err == nil || !strings.Contains(err.Error(), "generate a new re-pairing code") || strings.Contains(err.Error(), secret) {
		t.Fatalf("expected explicit recovery without secret, got %v", err)
	}
	if err = os.Remove(path); err != nil {
		t.Fatal(err)
	}
	writeConfig()
	failSave.Store(false)
	if err = run(); err != nil {
		t.Fatal(err)
	}
	saved, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(saved), `"custom": true`) || !strings.Contains(string(saved), server.URL+"/") || strings.Contains(string(saved), `"token"`) {
		t.Fatalf("retry lost configuration: %v", err)
	}
}
func TestMissingRePairConfigRequiresExplicitIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.json")
	if _, _, err := rePairConfig(repairOptions{Path: path}); err == nil {
		t.Fatal("missing identity accepted")
	}
	cfg, _, err := rePairConfig(repairOptions{Path: path, Server: "https://example.com", DeviceID: "device"})
	if err != nil || cfg.DeviceID != "device" {
		t.Fatalf("explicit recovery failed: %v", err)
	}
}
