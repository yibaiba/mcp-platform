package agent

import (
	"encoding/json"
	"errors"
	"mcplatform/connector/internal/config"
	"os"
	"strings"
	"testing"
)

func TestSharedAuthenticationVectors(t *testing.T) {
	data, err := os.ReadFile("../../../packages/contracts/testdata/device-auth-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		PlatformOrigin, NormalizedOrigin, DeviceID, DeviceSecret, Nonce, ExpiresAt, MAC string
		CredentialVersion                                                               int
	}
	if err = json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors {
		t.Run(vector.PlatformOrigin, func(t *testing.T) {
			origin, err := config.NormalizeOrigin(vector.PlatformOrigin)
			if err != nil || origin != vector.NormalizedOrigin {
				t.Fatalf("origin=%s err=%v", origin, err)
			}
			mac, err := AuthenticationMAC(config.Config{Server: vector.PlatformOrigin, DeviceID: vector.DeviceID, DeviceSecret: vector.DeviceSecret, CredentialVersion: vector.CredentialVersion}, Challenge{V: 1, Nonce: vector.Nonce, ExpiresAt: vector.ExpiresAt})
			if err != nil || mac != vector.MAC {
				t.Fatalf("MAC mismatch: %v", err)
			}
		})
	}
}

func TestCheckOriginReportsPublicURLMismatch(t *testing.T) {
	cfg := config.Config{Server: "http://localhost:4301"}
	err := CheckOrigin(cfg, Challenge{Origin: "http://localhost:4300"})
	var mismatch *OriginMismatchError
	if !errors.As(err, &mismatch) || mismatch.Configured != "http://localhost:4301" || mismatch.Platform != "http://localhost:4300" {
		t.Fatalf("expected origin mismatch, got %v", err)
	}
	if !strings.Contains(err.Error(), "PUBLIC_URL is http://localhost:4300") {
		t.Fatalf("error should name PUBLIC_URL: %v", err)
	}
	if err = CheckOrigin(config.Config{Server: "http://LOCALHOST:4300/"}, Challenge{Origin: "http://localhost:4300"}); err != nil {
		t.Fatalf("normalized origins must match: %v", err)
	}
	// Older platforms omit the origin; the MAC check stays authoritative.
	if err = CheckOrigin(cfg, Challenge{}); err != nil {
		t.Fatalf("missing origin must not fail: %v", err)
	}
}
