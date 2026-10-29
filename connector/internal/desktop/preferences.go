package desktop

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

type Preferences struct {
	ConfigPath string `json:"configPath"`
	DataDir    string `json:"dataDir,omitempty"`
	CAPath     string `json:"caPath,omitempty"`
}

func LoadPreferences(home string) (Preferences, error) {
	p := Preferences{ConfigPath: filepath.Join(home, ".mcplatform", "connector.json")}
	data, err := os.ReadFile(preferencesPath(home))
	if os.IsNotExist(err) {
		return p, nil
	}
	if err != nil {
		return p, err
	}
	if err := json.Unmarshal(data, &p); err != nil {
		return p, fmt.Errorf("read desktop preferences: %w", err)
	}
	return p, p.Validate()
}

func (p Preferences) Validate() error {
	if p.ConfigPath == "" {
		return fmt.Errorf("configuration path is required")
	}
	for _, path := range []string{p.ConfigPath, p.DataDir, p.CAPath} {
		if path != "" && !filepath.IsAbs(path) {
			return fmt.Errorf("settings paths must be absolute: %s", path)
		}
	}
	return nil
}

func (p Preferences) Save(home string) error {
	if err := p.Validate(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	path := preferencesPath(home)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".desktop-*")
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

func preferencesPath(home string) string { return filepath.Join(home, ".mcplatform", "desktop.json") }
