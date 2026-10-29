package connectorruntime

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"mcplatform/connector/internal/agent"
	"mcplatform/connector/internal/config"
	"mcplatform/connector/internal/local/sources"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func runtimeOptions(t *testing.T) Options {
	t.Helper()
	home := t.TempDir()
	return Options{DataDir: filepath.Join(home, "local"), Client: http.DefaultClient, MCPTransport: http.DefaultTransport,
		Locations: sources.Locations{Home: home}, Diagnostics: io.Discard, Error: func(err error) { t.Error(err) }}
}

func TestConnectionStatusRequiresAuthenticationAndStopsCleanly(t *testing.T) {
	events := make(chan agent.ConnectionState, 16)
	challengeReceived, release := make(chan struct{}), make(chan struct{})
	cfg := config.Config{DeviceID: "11111111-1111-4111-8111-111111111111", DeviceSecret: strings.Repeat("A", 43), CredentialVersion: 1}
	server := httptest.NewServer(authenticatedHandler(t, authenticationFixture{Config: &cfg, Received: challengeReceived, Release: release}))
	defer server.Close()
	cfg.Server = server.URL
	opts := runtimeOptions(t)
	opts.Changed = func(state agent.ConnectionState) { events <- state }
	runtime, err := Open(t.Context(), opts)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	if err := runtime.Connect(cfg); err != nil {
		t.Fatal(err)
	}
	select {
	case <-challengeReceived:
	case <-time.After(5 * time.Second):
		t.Fatal("connection not started")
	}
	if state := <-events; state.Phase != "connecting" {
		t.Fatalf("reported %s before authentication", state.Phase)
	}
	select {
	case state := <-events:
		t.Fatalf("premature state: %+v", state)
	default:
	}
	close(release)
	select {
	case state := <-events:
		if state.Phase != "connected" {
			t.Fatalf("state=%+v", state)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("missing authenticated state")
	}
	if err := runtime.Disconnect(); err != nil {
		t.Fatal(err)
	}
	if state := <-events; state.Phase != "disconnected" {
		t.Fatal(state)
	}
	if err := runtime.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(t.Context(), opts)
	if err != nil {
		t.Fatal("storage lease leaked:", err)
	}
	if err := reopened.Close(); err != nil {
		t.Fatal(err)
	}
}

type authenticationFixture struct {
	Config   *config.Config
	Received chan struct{}
	Release  chan struct{}
}

func authenticatedHandler(t *testing.T, fixture authenticationFixture) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		conn, err := websocket.Accept(w, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.CloseNow()
		close(fixture.Received)
		select {
		case <-fixture.Release:
		case <-t.Context().Done():
			return
		}
		challenge := agent.Challenge{Type: "auth.challenge", V: 1,
			Nonce: base64.RawURLEncoding.EncodeToString(make([]byte, 32)), ExpiresAt: time.Now().Add(30 * time.Second).UTC().Format(time.RFC3339Nano)}
		if !writeJSON(t, conn, challenge) {
			return
		}
		_, raw, err := conn.Read(t.Context())
		if err != nil {
			t.Error(err)
			return
		}
		var response struct {
			MAC string `json:"mac"`
		}
		if err := json.Unmarshal(raw, &response); err != nil {
			t.Error(err)
			return
		}
		expected, err := agent.AuthenticationMAC(*fixture.Config, challenge)
		if err != nil || response.MAC != expected {
			t.Errorf("invalid authentication response: %v", err)
			return
		}
		if !writeJSON(t, conn, map[string]any{"type": "auth.success", "v": 1}) {
			return
		}
		for {
			if _, _, err := conn.Read(t.Context()); err != nil {
				return
			}
		}
	}
}

func writeJSON(t *testing.T, conn *websocket.Conn, value any) bool {
	t.Helper()
	data, err := json.Marshal(value)
	if err == nil {
		err = conn.Write(t.Context(), websocket.MessageText, data)
	}
	if err != nil {
		t.Error(err)
		return false
	}
	return true
}

func TestRejectedAuthenticationNeverReportsConnected(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) { http.Error(w, "denied", http.StatusUnauthorized) }))
	defer server.Close()
	opts := runtimeOptions(t)
	events := make(chan agent.ConnectionState, 16)
	opts.Changed = func(state agent.ConnectionState) { events <- state }
	runtime, err := Open(t.Context(), opts)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	cfg := config.Config{Server: server.URL, DeviceID: "device", DeviceSecret: strings.Repeat("A", 43), CredentialVersion: 1}
	if err := runtime.Connect(cfg); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case state := <-events:
			if state.Phase == "connected" {
				t.Fatal("unauthenticated connection reported online")
			}
			if state.Phase == "reconnecting" {
				if !strings.Contains(state.Error, "401") {
					t.Fatal(state)
				}
				return
			}
		case <-time.After(5 * time.Second):
			t.Fatal("missing failure state")
		}
	}
}
