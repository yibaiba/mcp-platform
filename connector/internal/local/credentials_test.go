package local

import (
	"mcplatform/connector/internal/local/documents"
	"mcplatform/connector/internal/local/model"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMalformedSourceRejectsDispatchUntilRepaired(t *testing.T) {
	for _, scenario := range []string{"default", "dedicated-base", "dedicated-target"} {
		t.Run(scenario, func(t *testing.T) {
			s, path := fixture(t)
			r := resource(t, s)
			identity := "default"
			if _, err := mutate(t, s, model.Request{Action: "select", ID: r.ID, Selected: true}); err != nil {
				t.Fatal(err)
			}
			if scenario != "default" {
				identity = "dedicated"
				target := dedicatedResource(t, s, r)
				if _, err := mutate(t, s, model.Request{Action: "identity.bind", ID: target.ID, Identity: identity}); err != nil {
					t.Fatal(err)
				}
				if scenario == "dedicated-target" {
					path = target.Path
				}
			}
			original, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(path, []byte("{ broken secret-value"), 0600); err != nil {
				t.Fatal(err)
			}
			raw := documents.Encode(map[string]any{"config": map[string]string{
				"deviceResourceId": r.ID, "deviceResourceDigest": r.Digest, "localIdentity": identity,
			}})
			if _, err := s.Resolve(raw); err == nil || !strings.Contains(err.Error(), "LOCAL_RESOURCE_INVALID") {
				t.Fatalf("malformed source must reject cached configuration: %v", err)
			} else if strings.Contains(err.Error(), "secret-value") {
				t.Fatal("source contents leaked into error")
			}
			if err = os.WriteFile(path, original, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Resolve(raw); err != nil {
				t.Fatalf("repaired source rejected: %v", err)
			}
		})
	}
}

func dedicatedResource(t *testing.T, s *Service, base model.Resource) model.Resource {
	t.Helper()
	source, err := s.source(base)
	if err != nil {
		t.Fatal(err)
	}
	source.Path = filepath.Join(filepath.Dir(base.Path), "dedicated.json")
	if err := os.WriteFile(source.Path, []byte(`{"mcpServers":{"dedicated":{"command":"echo"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := mutate(t, s, model.Request{Action: "source.add", Source: &source}); err != nil {
		t.Fatal(err)
	}
	s.scan(t.Context())
	for _, r := range state(t, s, false).Resources {
		if r.Path != source.Path {
			continue
		}
		if _, err := mutate(t, s, model.Request{Action: "select", ID: r.ID, Selected: true}); err != nil {
			t.Fatal(err)
		}
		return r
	}
	t.Fatal("dedicated resource missing")
	return model.Resource{}
}
