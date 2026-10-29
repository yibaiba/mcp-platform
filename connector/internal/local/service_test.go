package local

import (
	"context"
	"encoding/json"
	"io"
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

func fixture(t *testing.T) (*Service, string) {
	t.Helper()
	home := t.TempDir()
	path := filepath.Join(home, ".cursor", "mcp.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{// outside
"theme":"keep", "mcpServers":{"test":{"command":"echo","args":["secret-argument"],"env":{"TOKEN":"secret-value"},"description":"original"},"other":{"command":"echo"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	manager := mcpclient.New(t.Context(), io.Discard, http.DefaultTransport)
	t.Cleanup(func() {
		if err := manager.CloseAll(); err != nil {
			t.Error(err)
		}
	})
	service, err := New(t.Context(), Options{Store: storage.Store{Dir: filepath.Join(home, "state")}, Locations: sources.Locations{Home: home}, Runtime: manager, Error: func(err error) { t.Log(err) }})
	if err != nil {
		t.Fatal(err)
	}
	return service, path
}
func state(t *testing.T, s *Service, remote bool) model.State {
	t.Helper()
	value, err := s.Execute(t.Context(), model.Request{Action: "state"}, remote)
	if err != nil {
		t.Fatal(err)
	}
	return value.(model.State)
}
func resource(t *testing.T, s *Service) model.Resource {
	t.Helper()
	for _, r := range state(t, s, false).Resources {
		if r.Name == "test" {
			return r
		}
	}
	t.Fatal("missing resource")
	return model.Resource{}
}
func mutate(t *testing.T, s *Service, r model.Request) (model.Operation, error) {
	t.Helper()
	r.ExpectedRevision = state(t, s, false).Revision
	if r.OperationID == "" {
		r.OperationID = r.Action + "-" + r.ID
	}
	result, err := s.Execute(t.Context(), r, false)
	if err != nil {
		return model.Operation{}, err
	}
	return result.(model.Operation), nil
}
func TestOfflineEditIdempotencyCredentialsAndRestore(t *testing.T) {
	s, path := fixture(t)
	r := resource(t, s)
	remote := state(t, s, true)
	encoded := string(documents.Encode(remote))
	if strings.Contains(encoded, "secret-value") || strings.Contains(encoded, "secret-argument") {
		t.Fatal("credential uploaded")
	}
	content, err := documents.Object(r.Content)
	if err != nil {
		t.Fatal(err)
	}
	content["description"] = "edited"
	request := model.Request{Action: "edit", ID: r.ID, OperationID: "edit-once", ExpectedRevision: state(t, s, false).Revision, ExpectedDigest: r.Digest, Content: documents.Encode(content)}
	value, err := s.Execute(t.Context(), request, false)
	if err != nil {
		t.Fatal(err)
	}
	if value.(model.Operation).Phase != "succeeded" {
		t.Fatal(value)
	}
	again, err := s.Execute(t.Context(), request, false)
	if err != nil || again.(model.Operation).Backup != value.(model.Operation).Backup {
		t.Fatal("idempotency failed", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "// outside") || !strings.Contains(string(data), `"theme":"keep"`) {
		t.Fatal("unrelated data lost", string(data))
	}
	updated := resource(t, s)
	if !updated.ReloadRequired || updated.LoadedVerified {
		t.Fatal("incorrect load status")
	}
	if _, err := mutate(t, s, model.Request{Action: "delete", ID: r.ID, ExpectedDigest: updated.Digest}); err == nil {
		t.Fatal("delete was not confirmed")
	}
	deletion, err := mutate(t, s, model.Request{Action: "delete", OperationID: "confirmed-delete", ID: r.ID, ExpectedDigest: updated.Digest, Confirm: true})
	if err != nil {
		t.Fatal(err)
	}
	deleted := resource(t, s)
	if !deleted.Deleted {
		t.Fatal("delete not observed")
	}
	_, err = mutate(t, s, model.Request{Action: "restore", ID: r.ID, ExpectedDigest: deleted.Digest, Content: documents.Encode(map[string]string{"operationId": deletion.ID})})
	if err != nil {
		t.Fatal(err)
	}
	if resource(t, s).Deleted {
		t.Fatal("restore did not recover resource")
	}
}
func TestExternalEditAndCorruptSourceAreNotOverwritten(t *testing.T) {
	s, path := fixture(t)
	r := resource(t, s)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, []byte(strings.Replace(string(data), "original", "external", 1)), 0600); err != nil {
		t.Fatal(err)
	}
	_, err = mutate(t, s, model.Request{Action: "edit", ID: r.ID, ExpectedDigest: r.Digest, Content: r.Content})
	if err == nil || !strings.Contains(err.Error(), "SOURCE_CONFLICT") {
		t.Fatal("external change was overwritten", err)
	}
	if err = os.WriteFile(path, []byte("{ broken secret-value"), 0600); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.scan(context.Background())
	s.mu.Unlock()
	current := resource(t, s)
	if current.Deleted || len(current.Issues) == 0 {
		t.Fatal("corruption became deletion", current)
	}
	if strings.Contains(strings.Join(state(t, s, true).Issues, ""), "secret-value") {
		t.Fatal("secret in diagnostics")
	}
}
func TestDedicatedIdentityNeverFallsBack(t *testing.T) {
	s, _ := fixture(t)
	r := resource(t, s)
	if _, err := mutate(t, s, model.Request{Action: "select", ID: r.ID, Selected: true}); err != nil {
		t.Fatal(err)
	}
	raw := documents.Encode(map[string]any{"config": map[string]string{"deviceResourceId": r.ID, "localIdentity": "binding-one"}})
	if _, err := s.Resolve(raw); err == nil || !strings.Contains(err.Error(), "IDENTITY_CREDENTIAL_REQUIRED") {
		t.Fatal("independent identity used shared credentials", err)
	}
	if _, err := mutate(t, s, model.Request{Action: "identity.bind", ID: r.ID, Identity: "binding-one"}); err != nil {
		t.Fatal(err)
	}
	resolved, err := s.Resolve(raw)
	if err != nil {
		t.Fatal(err)
	}
	var params struct {
		Config mcpclient.Config `json:"config"`
	}
	if err = json.Unmarshal(resolved, &params); err != nil {
		t.Fatal(err)
	}
	if params.Config.Env["TOKEN"] != "secret-value" {
		t.Fatal("dedicated credential not resolved")
	}
}
func TestRemoteCredentialEditsRejected(t *testing.T) {
	s, _ := fixture(t)
	r := resource(t, s)
	redacted := Redact(r)
	content, _ := documents.Object(redacted.Content)
	content["env"] = map[string]any{"TOKEN": "new-credential"}
	_, err := s.Execute(t.Context(), model.Request{Action: "edit", ID: r.ID, ExpectedRevision: state(t, s, false).Revision, ExpectedDigest: r.Digest, OperationID: "remote-secret", Content: documents.Encode(content)}, true)
	if err == nil {
		t.Fatal("platform credential write was accepted")
	}
}

func TestScanDoesNotExecuteCommandsOrCredentialExpressions(t *testing.T) {
	s, path := fixture(t)
	sentinel := filepath.Join(filepath.Dir(path), "must-not-exist")
	content := `{"mcpServers":{"test":{"command":"sh","args":["-c","touch ` + sentinel + `"],"env":{"TOKEN":"!touch ` + sentinel + `"}}}}`
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.scan(t.Context())
	s.mu.Unlock()
	if _, err := os.Stat(sentinel); !os.IsNotExist(err) {
		t.Fatal("scan executed a command", err)
	}
}
func TestSelectionsStayBoundToExplicitPlatformDevice(t *testing.T) {
	s, _ := fixture(t)
	options := s.options
	options.SyncTarget = "first-device"
	first, err := New(t.Context(), options)
	if err != nil {
		t.Fatal(err)
	}
	if first.state.SyncTarget != "first-device" {
		t.Fatal("target not persisted")
	}
	options.SyncTarget = "other-device"
	if _, err = New(t.Context(), options); err == nil {
		t.Fatal("selections were silently reassigned to another device")
	}
	options.SyncTarget = ""
	if _, err = New(t.Context(), options); err != nil {
		t.Fatal("offline access must remain available", err)
	}
}
func TestRestoreSelectedEntryAfterWholeConfigurationDeletion(t *testing.T) {
	s, path := fixture(t)
	r := resource(t, s)
	edited, _ := documents.Object(r.Content)
	edited["description"] = "after"
	op, err := mutate(t, s, model.Request{Action: "edit", ID: r.ID, ExpectedDigest: r.Digest, Content: documents.Encode(edited)})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(path); err != nil {
		t.Fatal(err)
	}
	s.scan(t.Context())
	r = resource(t, s)
	if !r.Deleted {
		t.Fatal("deletion was not detected")
	}
	_, err = mutate(t, s, model.Request{Action: "restore", ID: r.ID, ExpectedDigest: r.Digest, Content: documents.Encode(map[string]string{"operationId": op.ID}), Confirm: true})
	if err != nil {
		t.Fatal(err)
	}
	actual, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(actual), "original") || strings.Contains(string(actual), "other") {
		t.Fatal("restoration must only restore selected entry", string(actual))
	}
}
func TestInvalidEntryHasPerResourceDiagnosticInRemoteInventory(t *testing.T) {
	s, path := fixture(t)
	if err := os.WriteFile(path, []byte(`{"mcpServers":{"broken":42,"valid":{"command":"echo"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	s.scan(t.Context())
	snapshot := state(t, s, true)
	for _, r := range snapshot.Resources {
		if r.Name == "broken" {
			if string(r.Content) != "null" && r.Content != nil {
				t.Fatal("invalid content escaped boundary", string(r.Content))
			}
			if len(r.Issues) == 0 {
				t.Fatal("missing diagnostic")
			}
		}
	}
}

type observedRuntime struct {
	Runtime
	closed []string
}

func (r *observedRuntime) Close(id string) error {
	r.closed = append(r.closed, id)
	return r.Runtime.Close(id)
}
func TestExternalConfigurationInvalidatesConnectorOwnedLocalSession(t *testing.T) {
	s, path := fixture(t)
	r := resource(t, s)
	runtime := &observedRuntime{Runtime: s.options.Runtime}
	s.options.Runtime = runtime
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, []byte(strings.Replace(string(data), "original", "external change", 1)), 0600); err != nil {
		t.Fatal(err)
	}
	s.scan(t.Context())
	found := false
	for _, id := range runtime.closed {
		if id == runtimeID(r.ID) {
			found = true
		}
	}
	if !found {
		t.Fatal("local session survived source configuration change")
	}
}
