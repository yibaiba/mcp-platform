package config

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	Server            string            `json:"server"`
	DeviceID          string            `json:"deviceId"`
	DeviceSecret      string            `json:"deviceSecret"`
	CredentialVersion int               `json:"credentialVersion"`
	SkillRoots        map[string]string `json:"skillRoots"`
	ArtifactRoots     map[string]string `json:"artifactRoots"`
}

func ValidateServer(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if u.Hostname() == "" {
		return nil, fmt.Errorf("server requires a hostname")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, fmt.Errorf("server must be an origin URL")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (strings.EqualFold(u.Hostname(), "localhost") || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")) {
		return nil, fmt.Errorf("remote servers require HTTPS")
	}
	return u, nil
}

func Load(path string) (Config, error) {
	var c Config
	data, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	if err = json.Unmarshal(data, &c); err != nil {
		return c, err
	}
	if _, err = ValidateServer(c.Server); err != nil {
		return c, err
	}
	if c.DeviceID == "" || c.CredentialVersion < 1 {
		return c, fmt.Errorf("device must be paired first")
	}
	if err = ValidateSecret(c.DeviceSecret); err != nil {
		return c, err
	}
	for _, roots := range []map[string]string{c.SkillRoots, c.ArtifactRoots} {
		for name, path := range roots {
			if name == "" || !filepath.IsAbs(path) {
				return c, fmt.Errorf("root %q must be absolute", name)
			}
		}
	}
	return c, nil
}

func Save(path string, c Config) error {
	if _, err := os.Stat(path); err == nil {
		return fmt.Errorf("configuration already exists: %s", path)
	} else if !os.IsNotExist(err) {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, writeErr := f.Write(data)
	closeErr := f.Close()
	if writeErr != nil {
		return writeErr
	}
	return closeErr
}
