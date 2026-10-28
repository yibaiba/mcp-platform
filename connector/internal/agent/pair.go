package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/config"
	"net/http"
	"strings"
)

func Pair(ctx context.Context, client *http.Client, server, code string) (config.Config, error) {
	return exchange(ctx, client, pairingInput{Server: server, Code: code})
}

type pairingInput struct{ Server, Code, DeviceID string }

type RePairInput struct {
	Config config.Config
	Code   string
}

func RePair(ctx context.Context, client *http.Client, input RePairInput) (config.Config, error) {
	cfg := input.Config
	result, err := exchange(ctx, client, pairingInput{Server: cfg.Server, Code: input.Code, DeviceID: cfg.DeviceID})
	// The exact paired origin is also part of the local sync identity.
	result.Server = cfg.Server
	return result, err
}

func exchange(ctx context.Context, client *http.Client, input pairingInput) (config.Config, error) {
	server, code := input.Server, input.Code
	result := config.Config{Server: strings.TrimRight(server, "/"), SkillRoots: map[string]string{}, ArtifactRoots: map[string]string{}}
	if _, err := config.ValidateServer(server); err != nil {
		return result, err
	}
	body, err := json.Marshal(struct {
		Code     string `json:"code"`
		DeviceID string `json:"deviceId,omitempty"`
	}{code, input.DeviceID})
	if err != nil {
		return result, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, result.Server+"/api/v1/devices/pair", bytes.NewReader(body))
	if err != nil {
		return result, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return result, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		return result, fmt.Errorf("pairing failed: HTTP %d", response.StatusCode)
	}
	var paired struct {
		DeviceID          string `json:"deviceId"`
		DeviceSecret      string `json:"deviceSecret"`
		CredentialVersion int    `json:"credentialVersion"`
	}
	err = json.NewDecoder(response.Body).Decode(&paired)
	result.DeviceID, result.DeviceSecret, result.CredentialVersion = paired.DeviceID, paired.DeviceSecret, paired.CredentialVersion
	if err != nil {
		return result, fmt.Errorf("pairing succeeded but response could not be read; generate a new re-pairing code: %w", err)
	}
	if err = config.ValidateSecret(result.DeviceSecret); err != nil {
		return result, err
	}
	if result.DeviceID == "" || result.CredentialVersion < 1 || (input.DeviceID != "" && result.DeviceID != input.DeviceID) {
		return result, fmt.Errorf("invalid pairing response; generate a new re-pairing code")
	}
	return result, nil
}
