package localhttp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"testing"
	"time"
)

func openSession(t *testing.T, client *http.Client) (*Server, string) {
	t.Helper()
	s, err := Start(&managerFixture{})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- s.Serve() }()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.Close(ctx); err != nil {
			t.Error(err)
		}
		if err := <-done; err != nil {
			t.Error(err)
		}
	})
	r, err := http.NewRequest("POST", s.origin+"/local-api/v1/session", strings.NewReader(`{"token":"`+s.openToken+`"}`))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Origin", s.origin)
	r.Header.Set("Content-Type", "application/json")
	response, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatal(response.StatusCode)
	}
	var session struct {
		CSRF string `json:"csrf"`
	}
	if err := json.NewDecoder(response.Body).Decode(&session); err != nil {
		t.Fatal(err)
	}
	return s, session.CSRF
}

func TestLocalInstancesKeepIndependentBrowserSessions(t *testing.T) {
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar, Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()
	first, firstCSRF := openSession(t, client)
	second, secondCSRF := openSession(t, client)
	for _, session := range []struct {
		server *Server
		csrf   string
	}{{first, firstCSRF}, {second, secondCSRF}} {
		response, err := client.Get(session.server.origin + "/local-api/v1/session")
		if err != nil {
			t.Fatal(err)
		}
		var current struct {
			CSRF string `json:"csrf"`
		}
		if err := json.NewDecoder(response.Body).Decode(&current); err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("session overwritten: HTTP %d", response.StatusCode)
		}
		if current.CSRF != session.csrf {
			t.Fatal("session CSRF belongs to another instance")
		}
		r, err := http.NewRequest("POST", session.server.origin+"/local-api/v1/request", strings.NewReader(`{"action":"state"}`))
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("Origin", session.server.origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-CSRF-Token", session.csrf)
		response, err = client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		var result struct {
			Read bool `json:"read"`
		}
		if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("local request rejected: HTTP %d", response.StatusCode)
		}
		if !result.Read {
			t.Fatal("local request did not execute")
		}
	}
}
