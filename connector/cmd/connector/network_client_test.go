package main

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestPairingNetworkClientPreservesRedirectPolicy(t *testing.T) {
	destinationCalls := 0
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { destinationCalls++; w.WriteHeader(200) }))
	defer destination.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", destination.URL)
		w.WriteHeader(307)
	}))
	defer origin.Close()
	base, err := newHTTPClient("")
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	client, err := pairingHTTPClient(base, runtimeOptions{ConfigPath: filepath.Join(directory, "missing.json"), DataDir: directory})
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseIdleConnections()
	response, err := client.Get(origin.URL)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 307 || destinationCalls != 0 {
		t.Fatal("platform redirect policy was lost")
	}
}
