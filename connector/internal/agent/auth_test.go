package agent

import (
	"encoding/json"
	"mcplatform/connector/internal/config"
	"os"
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
