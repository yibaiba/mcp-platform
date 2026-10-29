package network

import (
	"context"
	"io"
	"mcplatform/connector/internal/platformclient"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestAcceleratorRelativeRedirectsAndCredentialIsolation(t *testing.T) {
	for _, location := range []string{"/next", "next", "?stage=next"} {
		t.Run(location, func(t *testing.T) {
			destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("X-Private") != "" {
					t.Error("credentials crossed redirect origin")
				}
				_, _ = w.Write([]byte("download"))
			}))
			defer destination.Close()
			var calls atomic.Int32
			accelerator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer accelerator-fixture" {
					t.Error("accelerator credential missing")
				}
				if r.Header.Get("Cookie") != "" || r.Header.Get("X-Private") != "" {
					t.Error("original credentials reached accelerator")
				}
				switch calls.Add(1) {
				case 1:
					http.Redirect(w, r, location, http.StatusFound)
				case 2:
					http.Redirect(w, r, "/last", http.StatusTemporaryRedirect)
				default:
					http.Redirect(w, r, destination.URL, http.StatusFound)
				}
			}))
			defer accelerator.Close()
			store, err := Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			_, err = store.Save(Save{Settings: Settings{GitHubDownload: accelerator.URL + "/download/fetch?url={encodedUrl}"}, Secrets: map[string]Edit{"githubDownloadToken": {Action: "replace", Value: "accelerator-fixture"}}})
			if err != nil {
				t.Fatal(err)
			}
			transport := &Transport{Store: store, Base: http.DefaultTransport}
			defer transport.CloseIdleConnections()
			client := &http.Client{Transport: transport, CheckRedirect: Redirect, Timeout: 3 * time.Second}
			request, err := http.NewRequest("GET", "https://github.com/owner/repo/archive/ref.zip", nil)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Authorization", "Bearer original-fixture")
			request.Header.Set("Cookie", "private=fixture")
			request.Header.Set("X-Private", "fixture")
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(response.Body)
			response.Body.Close()
			if err != nil || string(body) != "download" || calls.Load() != 3 {
				t.Fatal(string(body), calls.Load(), err)
			}
		})
	}
}

func TestConnectivityChecksFollowRedirectsWithoutChangingPlatformPolicy(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/download" {
			http.Redirect(w, r, "/final", http.StatusFound)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/info/refs") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.Save(Save{Settings: Settings{GitHubAPI: server.URL, GitHubDownload: server.URL + "/download?url={encodedUrl}", GitHubClone: server.URL + "/{owner}/{repo}"}})
	if err != nil {
		t.Fatal(err)
	}
	client, err := platformclient.New("")
	if err != nil {
		t.Fatal(err)
	}
	client.Transport = &Transport{Store: store, Base: client.Transport}
	defer client.CloseIdleConnections()
	for _, result := range Check(context.Background(), store, client) {
		if result["kind"] != "git" && result["ok"] != true {
			t.Fatal(result)
		}
	}
	response, err := client.Get(server.URL + "/download")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusFound {
		t.Fatal("platform redirects were enabled", response.StatusCode)
	}
}

func TestRedirectRejectsGithubBodyAndClearsGetContentHeaders(t *testing.T) {
	previous := httptest.NewRequest("POST", "https://github.com/login", strings.NewReader("fixture"))
	previous.Header.Set("Authorization", "Bearer fixture")
	previous.Header.Set("Content-Type", "application/json")
	previous.Header.Set("Content-Length", "7")
	next := httptest.NewRequest("POST", "https://other.test/login", strings.NewReader("fixture"))
	if err := Redirect(next, []*http.Request{previous}); err == nil {
		t.Fatal("GitHub body redirected across origins")
	}
	next = httptest.NewRequest("GET", "https://other.test/login", nil)
	if err := Redirect(next, []*http.Request{previous}); err != nil {
		t.Fatal(err)
	}
	if next.Header.Get("Content-Type") != "" || next.Header.Get("Content-Length") != "" || next.Header.Get("Authorization") != "" {
		t.Fatal("GET redirect retained body or credential headers")
	}
}
