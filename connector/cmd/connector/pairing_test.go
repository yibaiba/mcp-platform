package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"mcplatform/connector/internal/config"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestConnectPairsOnceAndReusesSavedConfiguration(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var input map[string]string
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input["code"] != "one-time-code" || r.URL.Path != "/api/v1/devices/pair" {
			http.Error(w, "invalid pairing request", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{"deviceId": "test-device", "deviceSecret": base64.RawURLEncoding.EncodeToString(make([]byte, 32)), "credentialVersion": 1})
	}))
	defer server.Close()
	var output bytes.Buffer
	options := pairingOptions{Path: filepath.Join(t.TempDir(), "private", "connector.json"), Server: server.URL, Client: server.Client(), Input: strings.NewReader("one-time-code"), Output: &output}
	if err := prepareConnection(context.Background(), options, true); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(options.Path)
	if err != nil {
		t.Fatal(err)
	}
	options.Input = strings.NewReader("")
	options.Server += "/"
	if err := prepareConnection(context.Background(), options, true); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(options.Path)
	if err != nil || !bytes.Equal(before, after) || calls.Load() != 1 {
		t.Fatal("reconnecting changed configuration or paired again", err)
	}
	if strings.Contains(output.String(), base64.RawURLEncoding.EncodeToString(make([]byte, 32))) || strings.Contains(output.String(), "one-time-code") {
		t.Fatal("pairing output disclosed credentials")
	}
}

func TestConnectRejectsInvalidSavedConfigurationWithoutPairing(t *testing.T) {
	for _, content := range []string{"invalid JSON", `{"server":"https://platform.example","deviceId":"test-device"}`} {
		t.Run(content, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "connector.json")
			if err := os.WriteFile(path, []byte(content), 0600); err != nil {
				t.Fatal(err)
			}
			err := prepareConnection(context.Background(), pairingOptions{Path: path}, true)
			if err == nil || !strings.Contains(err.Error(), "cannot reuse configuration") {
				t.Fatal("invalid configuration did not fail explicitly", err)
			}
		})
	}
}

func TestConnectRejectsDifferentPlatformAndPairPreservesConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "connector.json")
	if err := config.Save(path, config.Config{Server: "https://platform.example/", DeviceID: "device", DeviceSecret: base64.RawURLEncoding.EncodeToString(make([]byte, 32)), CredentialVersion: 1}); err != nil {
		t.Fatal(err)
	}
	options := pairingOptions{Path: path, Server: "https://platform.example", Output: io.Discard}
	if err := prepareConnection(context.Background(), options, true); err != nil {
		t.Fatal("equivalent platform origin rejected", err)
	}
	options.Server = "https://other.example"
	if err := prepareConnection(context.Background(), options, true); err == nil || !strings.Contains(err.Error(), "differs") {
		t.Fatal("accepted another platform with saved credentials", err)
	}
	if err := prepareConnection(context.Background(), options, false); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatal("pair replaced an existing configuration", err)
	}
}

func TestConnectRequiresServerAndNonemptyCode(t *testing.T) {
	options := pairingOptions{Path: filepath.Join(t.TempDir(), "connector.json")}
	if err := prepareConnection(context.Background(), options, true); err == nil || !strings.Contains(err.Error(), "--server") {
		t.Fatal("missing server did not fail explicitly", err)
	}
	if _, err := readPairingCode(strings.NewReader("\n")); err == nil {
		t.Fatal("accepted an empty pairing code")
	}
}
