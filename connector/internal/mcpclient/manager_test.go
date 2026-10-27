package mcpclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

const initializationTestTimeout = 5 * time.Second

func TestSSEInitializationCancellation(t *testing.T) {
	started := make(chan struct{})
	requestClosed := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(requestClosed)
	}))
	t.Cleanup(server.Close)
	ctx, cancel := context.WithTimeout(t.Context(), initializationTestTimeout)
	t.Cleanup(cancel)
	manager := New(t.Context(), io.Discard, http.DefaultTransport)
	t.Cleanup(func() {
		if err := manager.CloseAll(); err != nil {
			t.Error(err)
		}
	})
	params, err := json.Marshal(Params{ConnectionID: "cancel-sse", Config: Config{
		Transport: "sse", Mode: "existing", URL: server.URL,
	}})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := manager.Execute(ctx, "discover", params)
		done <- err
	}()
	select {
	case <-started:
		cancel()
	case <-ctx.Done():
		t.Fatal("SSE initialization never reached the server")
	}
	if err := <-done; err == nil {
		t.Fatal("cancelled initialization unexpectedly succeeded")
	}
	select {
	case <-requestClosed:
	case <-time.After(initializationTestTimeout):
		t.Fatal("cancelled SSE initialization left its HTTP request open")
	}
}
