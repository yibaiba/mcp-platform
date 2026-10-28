package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// ReadForRePair accepts an old credential format while preserving every other field.
func ReadForRePair(path string) (Config, map[string]json.RawMessage, error) {
	var cfg Config
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg, nil, err
	}
	var fields map[string]json.RawMessage
	if err = json.Unmarshal(data, &fields); err != nil {
		return cfg, nil, err
	}
	if fields == nil {
		return cfg, nil, fmt.Errorf("configuration must be an object")
	}
	err = json.Unmarshal(data, &cfg)
	return cfg, fields, err
}

func ReplaceCredentials(path string, fields map[string]json.RawMessage, cfg Config) error {
	next := make(map[string]json.RawMessage, len(fields))
	for key, value := range fields {
		if key != "token" {
			next[key] = value
		}
	}
	for key, value := range map[string]any{"server": cfg.Server, "deviceId": cfg.DeviceID, "deviceSecret": cfg.DeviceSecret, "credentialVersion": cfg.CredentialVersion} {
		raw, err := json.Marshal(value)
		if err != nil {
			return err
		}
		next[key] = raw
	}
	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	return atomicReplace(path, data)
}

func atomicReplace(path string, data []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".connector-stage-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), path)
}
