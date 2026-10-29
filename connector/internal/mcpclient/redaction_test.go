package mcpclient

import (
	"bytes"
	"strings"
	"testing"
)

func TestLocalDiagnosticsRedactChunkedCredentialsAndTail(t *testing.T) {
	var out bytes.Buffer
	writer := diagnosticWriter{output: &out, secrets: credentialStrings(Config{Args: []string{"--token=argument-secret"}, Env: map[string]string{"TOKEN": "private-token"}, Headers: map[string]string{"Authorization": "Bearer header-secret"}})}
	for _, part := range []string{"failed private-", "token\nthen --token=argument-secret and Bearer header-secret"} {
		if _, err := writer.Write([]byte(part)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"private-token", "argument-secret", "header-secret"} {
		if strings.Contains(out.String(), secret) {
			t.Fatal("credential leaked", out.String())
		}
	}
	if !strings.Contains(out.String(), "failed [redacted]") {
		t.Fatal("diagnostic lost", out.String())
	}
}
