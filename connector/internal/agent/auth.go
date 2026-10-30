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
	// Origin is the platform's PUBLIC_URL origin. Older platforms omit it.
	Origin string `json:"origin,omitempty"`
}

// OriginMismatchError reports a connector configured for a different origin than the platform's PUBLIC_URL.
type OriginMismatchError struct {
	Configured string
	Platform   string
}

func (e *OriginMismatchError) Error() string {
	return fmt.Sprintf("platform origin mismatch: this connector uses --server %s but the platform's PUBLIC_URL is %s; device authentication is bound to PUBLIC_URL. Re-run the install command copied from the platform's device page, or run connector connect --server %s (re-pair if the device was paired through the other address)", e.Configured, e.Platform, e.Platform)
}

// CheckOrigin compares the configured server origin with the origin announced in the challenge.
func CheckOrigin(cfg config.Config, challenge Challenge) error {
	if challenge.Origin == "" {
		return nil
	}
	configured, err := config.NormalizeOrigin(cfg.Server)
	if err != nil {
		return err
	}
	platform, err := config.NormalizeOrigin(challenge.Origin)
	if err != nil {
		// Informational field only: an origin we cannot normalize falls back to the MAC check.
		return nil
	}
	if configured != platform {
		return &OriginMismatchError{Configured: configured, Platform: platform}
	}
	return nil
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
	if err = CheckOrigin(r.Config, challenge); err != nil {
		// Tell the platform why we stop so its log shows the cause; never sign for a foreign origin.
		_ = r.send(ctx, conn, map[string]any{"type": "auth.abort", "v": 1, "reason": "origin_mismatch"})
		return err
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
		return fmt.Errorf("device authentication failed (check the platform server log for the DEVICE_AUTH_* reason): if --server differs from the platform's PUBLIC_URL, re-run the install command copied from the platform page; otherwise generate a re-pairing code and run connector re-pair")
	}
	return nil
}
