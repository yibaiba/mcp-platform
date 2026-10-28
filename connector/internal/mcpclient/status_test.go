package mcpclient

import (
	"io"
	"net/http"
	"testing"
)

func TestHeartbeatUsesConnectionIDInsteadOfSessionKey(t *testing.T) {
	manager := New(t.Context(), io.Discard, http.DefaultTransport)
	connectionID := "f0816858-5639-4b6a-b65c-2aaed3ebe2da"
	manager.entries[connectionID+":binding:session"] = &Entry{ConnectionID: connectionID, LastError: "disconnected"}
	status := manager.Status()
	if len(status) != 1 || status[0]["id"] != connectionID {
		t.Fatalf("heartbeat must identify the original connection: %#v", status)
	}
	if status[0]["status"] != "error" || status[0]["error"] != "disconnected" {
		t.Fatalf("heartbeat lost the failure status: %#v", status)
	}
}
