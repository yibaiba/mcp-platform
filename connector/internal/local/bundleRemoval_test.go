package local

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"mcplatform/connector/internal/bundles"
	"mcplatform/connector/internal/local/documents"
	"mcplatform/connector/internal/local/model"
	"mcplatform/connector/internal/local/sources"
	"mcplatform/connector/internal/local/storage"
	"mcplatform/connector/internal/mcpclient"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func localBundleFixture(t *testing.T) (*Service, *bundles.Store, string) {
	t.Helper()
	home := t.TempDir()
	store := &bundles.Store{Dir: filepath.Join(home, "mcpb")}
	var data bytes.Buffer
	writer := zip.NewWriter(&data)
	file, err := writer.Create("manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = file.Write([]byte(`{"name":"review","version":"1","server":{"type":"node"}}`)); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data.Bytes())
	hash := hex.EncodeToString(sum[:])
	config := documents.Encode(map[string]any{"command": "node", "transport": "stdio", "mode": "managed", "cwd": filepath.Join(store.Dir, "packages", hash)})
	if _, err = store.Install(documents.Encode(bundles.Install{SHA256: hash, Archive: base64.StdEncoding.EncodeToString(data.Bytes()), OperationID: "review", Config: config})); err != nil {
		t.Fatal(err)
	}
	manager := mcpclient.New(t.Context(), io.Discard, http.DefaultTransport)
	service, err := New(t.Context(), Options{Bundles: store, Store: storage.Store{Dir: filepath.Join(home, "state")}, Locations: sources.Locations{Home: home}, Runtime: manager, Error: func(err error) { t.Error(err) }})
	if err != nil {
		t.Fatal(err)
	}
	return service, store, hash
}

func TestStaleBundleRemovalDoesNotCancelCurrentCall(t *testing.T) {
	service, store, hash := localBundleFixture(t)
	invalidations := 0
	service.options.Changed = func(string) error { invalidations++; return nil }
	resource, err := service.bundleResource(hash)
	if err != nil {
		t.Fatal(err)
	}
	active, cancel := context.WithCancel(t.Context())
	defer cancel()
	service.active[resource.ID] = cancel
	_, err = service.Execute(t.Context(), model.Request{Action: "mcpb.remove", ID: hash, Content: documents.Encode(map[string]string{"revision": "stale"})}, false)
	if err == nil || !strings.Contains(err.Error(), "changed") {
		t.Fatalf("expected stale revision error: %v", err)
	}
	if _, err = store.Configuration(hash); err != nil {
		t.Fatal("current configuration removed", err)
	}
	if invalidations != 0 {
		t.Fatal("stale removal invalidated remote sessions")
	}
	if active.Err() != nil {
		t.Fatal("rejected stale removal cancelled the current call:", active.Err())
	}
}

func TestCurrentBundleRemovalCancelsCallAndRemovesConfiguration(t *testing.T) {
	service, store, hash := localBundleFixture(t)
	resource, err := service.bundleResource(hash)
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	descriptor, err := store.Descriptor(hash, executable)
	if err != nil {
		t.Fatal(err)
	}
	args := descriptor["args"].([]string)
	active, cancel := context.WithCancel(t.Context())
	defer cancel()
	service.active[resource.ID] = cancel
	invalidations := 0
	service.options.Changed = func(string) error { invalidations++; return nil }
	_, err = service.Execute(t.Context(), model.Request{Action: "mcpb.remove", ID: hash, Content: documents.Encode(map[string]string{"revision": args[len(args)-1]})}, false)
	if err != nil {
		t.Fatal(err)
	}
	if active.Err() == nil || invalidations == 0 {
		t.Fatal("current removal did not invalidate active sessions")
	}
	if _, err = store.Configuration(hash); !os.IsNotExist(err) {
		t.Fatal("configuration retained:", err)
	}
}
