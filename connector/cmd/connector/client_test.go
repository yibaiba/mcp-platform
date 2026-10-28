package main

import (
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestExplicitPlatformCATrustKeepsTLSVerification(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "ca.pem")
	data := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	client, err := newHTTPClient(path)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	transport := client.Transport.(*http.Transport)
	defer transport.CloseIdleConnections()
	if transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("TLS verification disabled")
	}
	if err = os.WriteFile(path, []byte("invalid certificate"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = newHTTPClient(path); err == nil {
		t.Fatal("invalid CA accepted")
	}
	if _, err = newHTTPClient(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("missing CA accepted")
	}
}
