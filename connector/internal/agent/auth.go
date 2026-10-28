package agent

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/config"
	"time"

	"github.com/coder/websocket"
)

const authMaxBytes = 4096
const authLifetime = 30 * time.Second

type Challenge struct {
	Type      string `json:"type"`
	V         int    `json:"v"`
	Nonce     string `json:"nonce"`
	ExpiresAt string `json:"expiresAt"`
}

func AuthenticationMAC(cfg config.Config, challenge Challenge) (string, error) {
	if err := config.ValidateSecret(cfg.DeviceSecret); err != nil {
		return "", err
	}
	origin, err := config.NormalizeOrigin(cfg.Server)
	if err != nil {
		return "", err
	}
	// Encoder escapes HTML by default; disable it to match JSON.stringify bytes exactly.
	var input bytes.Buffer
	encoder := json.NewEncoder(&input)
	encoder.SetEscapeHTML(false)
	if err = encoder.Encode([]any{"mcplatform-device-auth", 1, origin, cfg.DeviceID, cfg.CredentialVersion, challenge.Nonce, challenge.ExpiresAt}); err != nil {
		return "", err
	}
	secret, err := base64.RawURLEncoding.Strict().DecodeString(cfg.DeviceSecret)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(bytes.TrimSuffix(input.Bytes(), []byte{'\n'}))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func (r *Runner) authenticate(parent context.Context, conn *websocket.Conn) error {
	ctx, cancel := context.WithTimeout(parent, authLifetime)
	defer cancel()
	conn.SetReadLimit(authMaxBytes)
	kind, raw, err := conn.Read(ctx)
	if err != nil {
		return fmt.Errorf("device authentication challenge: %w", err)
	}
	var challenge Challenge
	if kind != websocket.MessageText || json.Unmarshal(raw, &challenge) != nil || challenge.Type != "auth.challenge" || challenge.V != 1 {
		return fmt.Errorf("invalid device authentication challenge")
	}
	nonce, err := base64.RawURLEncoding.Strict().DecodeString(challenge.Nonce)
	expires, timeErr := time.Parse(time.RFC3339Nano, challenge.ExpiresAt)
	if err != nil || len(nonce) != sha256.Size || timeErr != nil || !expires.After(time.Now()) {
		return fmt.Errorf("invalid or expired device authentication challenge")
	}
	mac, err := AuthenticationMAC(r.Config, challenge)
	if err != nil {
		return err
	}
	if err = r.send(ctx, conn, map[string]any{"type": "auth.response", "v": 1, "deviceId": r.Config.DeviceID, "credentialVersion": r.Config.CredentialVersion, "mac": mac}); err != nil {
		return err
	}
	kind, raw, err = conn.Read(ctx)
	if err != nil {
		return fmt.Errorf("device authentication response: %w", err)
	}
	var result struct {
		Type string `json:"type"`
		V    int    `json:"v"`
	}
	if kind != websocket.MessageText || json.Unmarshal(raw, &result) != nil || result.Type != "auth.success" || result.V != 1 {
		return fmt.Errorf("device authentication failed; generate a re-pairing code and run connector re-pair")
	}
	return nil
}
