package pairing

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestNewPairDoesNotConsumeCodeWhenConfigurationExists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "connector.json")
	original := []byte(`{"custom":"preserve"}`)
	if err := os.WriteFile(path, original, 0600); err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		http.Error(w, "unexpected", http.StatusInternalServerError)
	}))
	defer server.Close()
	_, err := Save(t.Context(), server.Client(), Options{Action: "pair", Path: path, Server: server.URL, Code: "single-use-code"})
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatal(err)
	}
	if requests.Load() != 0 {
		t.Fatal("code was sent despite an existing configuration")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != string(original) {
		t.Fatalf("configuration changed: %v", err)
	}
}
