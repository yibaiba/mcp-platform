package network

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrivateSourcesAndExplicitOverride(t *testing.T) {
	c := Config{Settings: Settings{NPMRegistry: "https://mirror.test", PythonIndex: "https://mirror.test/simple", ReplacePublicSources: true}}
	input := Command{Command: "npx", Args: []string{"--registry", "https://private.test", "pkg@1.0.0"}}
	p, err := Resolve(input, c)
	if err != nil || p.Source != "https://private.test" {
		t.Fatalf("private source: %v %v", p, err)
	}
	input.PackageSource = "https://explicit.test"
	p, err = Resolve(input, c)
	if err != nil || p.Source != input.PackageSource {
		t.Fatal(p, err)
	}
	input = Command{Command: "uv", Args: []string{"tool", "run", "--from", "pkg==1.0.0", "pkg"}}
	p, err = Resolve(input, c)
	if err != nil || p.Source != "https://mirror.test/simple" || p.Configured != "==1.0.0" {
		t.Fatal(p, err)
	}
}
func TestBypass(t *testing.T) {
	for _, v := range []struct {
		raw, pattern string
		want         bool
	}{{"https://api.test.com", ".test.com:443", true}, {"http://api.test.com", ".test.com:443", false}, {"http://[::1]:999", "[::1]:999", true}, {"http://127.0.0.1", "127.0.0.1", true}, {"https://eviltest.com", "test.com", false}} {
		u, _ := url.Parse(v.raw)
		if Bypass(u, v.pattern) != v.want {
			t.Fatal(v)
		}
	}
}
func TestEncryptedSettingsAndRevision(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	input := Save{Settings: Settings{HTTPProxy: "http://localhost:8888"}, Secrets: map[string]Edit{"httpProxyAuth": {Action: "replace", Value: "device-secret"}}}
	view, err := s.Save(input)
	if err != nil || !view.Secrets["httpProxyAuth"] {
		t.Fatal(view, err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "network.enc"))
	if strings.Contains(string(raw), "device-secret") {
		t.Fatal("plaintext persisted")
	}
	if _, err = s.Save(input); err == nil {
		t.Fatal("stale save accepted")
	}
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := reopened.Snapshot()
	if c.Secrets["httpProxyAuth"] != "device-secret" {
		t.Fatal("secret lost")
	}
	if _, err = s.Save(Save{Revision: 1, Settings: input.Settings, Secrets: map[string]Edit{"httpProxyAuth": {Action: "clear"}}}); err != nil {
		t.Fatal(err)
	}
	if s.View().Secrets["httpProxyAuth"] {
		t.Fatal("secret not cleared")
	}
}
func TestProxyFailureDoesNotConnectDirectly(t *testing.T) {
	hits := 0
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++; w.Write([]byte("ok")) }))
	defer origin.Close()
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.Save(Save{Settings: Settings{HTTPProxy: "http://127.0.0.1:1"}})
	if err != nil {
		t.Fatal(err)
	}
	transport := &Transport{Store: store, Base: http.DefaultTransport}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	if _, err = client.Get(origin.URL); err == nil {
		t.Fatal("broken proxy succeeded")
	}
	if hits != 0 {
		t.Fatal("fell back to direct")
	}
	_, err = store.Save(Save{Revision: 1, Settings: Settings{HTTPProxy: "http://127.0.0.1:1", NoProxy: "127.0.0.1"}})
	if err != nil {
		t.Fatal(err)
	}
	res, err := client.Get(origin.URL)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if hits != 1 {
		t.Fatal(hits)
	}
}
