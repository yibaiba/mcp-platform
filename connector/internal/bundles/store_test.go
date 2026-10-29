package bundles

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func fixture(t *testing.T, name string, mode os.FileMode) Install {
	t.Helper()
	var data bytes.Buffer
	writer := zip.NewWriter(&data)
	manifest, _ := writer.Create("manifest.json")
	manifest.Write([]byte(`{"name":"test","version":"1","server":{"type":"node"}}`))
	header := &zip.FileHeader{Name: name}
	header.SetMode(mode)
	entry, err := writer.CreateHeader(header)
	if err != nil {
		t.Fatal(err)
	}
	entry.Write([]byte("console.log('test')"))
	writer.Close()
	sum := sha256.Sum256(data.Bytes())
	return Install{SHA256: hex.EncodeToString(sum[:]), Archive: base64.StdEncoding.EncodeToString(data.Bytes()), OperationID: "operation"}
}
func raw(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
func TestInstallIntegrityAndImmutability(t *testing.T) {
	s := &Store{Dir: t.TempDir()}
	input := fixture(t, "server.js", 0600)
	if _, err := s.Install(raw(t, input)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Install(raw(t, input)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.Dir, "packages", input.SHA256, "server.js"), []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Install(raw(t, input)); err == nil {
		t.Fatal("modified package was accepted")
	}
	input.SHA256 = string(bytes.Repeat([]byte("0"), 64))
	if _, err := s.Install(raw(t, input)); err == nil {
		t.Fatal("wrong digest accepted")
	}
}
func TestRejectArchiveEscapeAndLinks(t *testing.T) {
	for _, input := range []Install{fixture(t, "../outside", 0600), fixture(t, "link", os.ModeSymlink|0777)} {
		s := &Store{Dir: t.TempDir()}
		if _, err := s.Install(raw(t, input)); err == nil {
			t.Fatal("unsafe archive accepted")
		}
	}
}
func TestConfigurationEncryptedAndOperationBound(t *testing.T) {
	s := &Store{Dir: t.TempDir()}
	input := fixture(t, "server.js", 0600)
	input.Config = raw(t, map[string]any{"command": "node", "cwd": filepath.Join(s.Dir, "packages", input.SHA256), "env": map[string]string{"KEY": "private-value"}})
	if _, err := s.Install(raw(t, input)); err != nil {
		t.Fatal(err)
	}
	stored, err := os.ReadFile(filepath.Join(s.Dir, input.SHA256+".enc"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(stored, []byte("private-value")) {
		t.Fatal("plaintext secret stored")
	}
	reopened := &Store{Dir: s.Dir}
	config, err := reopened.Configuration(input.SHA256)
	if err != nil || !bytes.Equal(config, input.Config) {
		t.Fatal("configuration roundtrip", err)
	}
	items, err := reopened.List()
	if err != nil || len(items) != 1 {
		t.Fatal("list", err)
	}
	input.Config = raw(t, map[string]any{"command": "python", "cwd": filepath.Join(s.Dir, "packages", input.SHA256)})
	if _, err = reopened.Install(raw(t, input)); err == nil {
		t.Fatal("operation ID accepted new input")
	}
}
