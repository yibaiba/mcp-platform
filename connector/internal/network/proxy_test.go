package network

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestAuthenticatedCONNECTAndTrustedOrigin(t *testing.T) {
	var origins, tunnels atomic.Int32
	origin := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origins.Add(1)
		if r.Header.Get("Proxy-Authorization") != "" {
			t.Error("proxy credential reached origin")
		}
		_, _ = w.Write([]byte("origin"))
	}))
	defer origin.Close()
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "CONNECT" || r.Header.Get("Proxy-Authorization") != "Basic dXNlcjpwYXNz" {
			w.WriteHeader(407)
			return
		}
		upstream, err := net.Dial("tcp", r.Host)
		if err != nil {
			w.WriteHeader(502)
			return
		}
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			upstream.Close()
			return
		}
		tunnels.Add(1)
		_, _ = conn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
		go func() { defer conn.Close(); defer upstream.Close(); _, _ = io.Copy(upstream, conn) }()
		go func() { defer conn.Close(); defer upstream.Close(); _, _ = io.Copy(conn, upstream) }()
	}))
	defer proxy.Close()
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	settings := Settings{HTTPProxy: proxy.URL}
	if _, err = store.Save(Save{Settings: settings, Secrets: map[string]Edit{"httpProxyAuth": {Action: "replace", Value: "user:pass"}}}); err != nil {
		t.Fatal(err)
	}
	transport := &Transport{Store: store, Base: origin.Client().Transport}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport}
	for i := 0; i < 2; i++ {
		response, err := client.Get(origin.URL)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || string(data) != "origin" {
			t.Fatal(string(data), err)
		}
		if i == 0 {
			settings.NoProxy = "127.0.0.1"
			if _, err = store.Save(Save{Revision: 1, Settings: settings}); err != nil {
				t.Fatal(err)
			}
		}
	}
	if tunnels.Load() != 1 || origins.Load() != 2 {
		t.Fatal(tunnels.Load(), origins.Load())
	}
}
