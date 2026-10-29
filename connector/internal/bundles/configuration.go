package bundles

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/local/storage"
	"os"
	"path/filepath"
	"strings"
)

type Configuration struct {
	SHA256 string          `json:"sha256"`
	Name   string          `json:"name"`
	Config json.RawMessage `json:"config"`
}

func (s *Store) cipher() (cipher.AEAD, error) {
	if err := os.MkdirAll(s.Dir, 0700); err != nil {
		return nil, err
	}
	path := filepath.Join(s.Dir, "configuration.key")
	key, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		key = make([]byte, 32)
		if _, err = rand.Read(key); err != nil {
			return nil, err
		}
		stage, err := os.CreateTemp(s.Dir, ".key-")
		if err != nil {
			return nil, err
		}
		defer os.Remove(stage.Name())
		if err = stage.Chmod(0600); err == nil {
			_, err = stage.Write(key)
		}
		if err == nil {
			err = stage.Sync()
		}
		closeErr := stage.Close()
		if err != nil {
			return nil, err
		}
		if closeErr != nil {
			return nil, closeErr
		}
		if err = os.Link(stage.Name(), path); os.IsExist(err) {
			key, err = os.ReadFile(path)
		}
		if err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func (s *Store) saveConfiguration(input Install) error {
	var config struct {
		Command string `json:"command"`
		Cwd     string `json:"cwd"`
	}
	if err := json.Unmarshal(input.Config, &config); err != nil {
		return err
	}
	if config.Command == "" || config.Cwd != filepath.Join(s.Dir, "packages", input.SHA256) {
		return fmt.Errorf("bundle launch must use its installation directory")
	}
	aead, err := s.cipher()
	if err != nil {
		return err
	}
	opSum := sha256.Sum256([]byte(input.OperationID))
	opPath := filepath.Join(s.Dir, hex.EncodeToString(opSum[:])+".operation")
	fingerprint := sha256.Sum256(input.Config)
	if old, err := os.ReadFile(opPath); err == nil {
		if string(old) != hex.EncodeToString(fingerprint[:]) {
			return fmt.Errorf("operation ID already used with different configuration")
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return err
	}
	encrypted := aead.Seal(nonce, nonce, input.Config, []byte(input.SHA256))
	if err = storage.Atomic(filepath.Join(s.Dir, input.SHA256+".enc"), encrypted, 0600); err != nil {
		return err
	}
	return storage.Atomic(opPath, []byte(hex.EncodeToString(fingerprint[:])), 0600)
}
func (s *Store) Configuration(hash string) (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !hashPattern.MatchString(hash) {
		return nil, fmt.Errorf("invalid bundle digest")
	}
	aead, err := s.cipher()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(s.Dir, hash+".enc"))
	if err != nil {
		return nil, err
	}
	if len(data) < aead.NonceSize() {
		return nil, fmt.Errorf("invalid encrypted bundle configuration")
	}
	return aead.Open(nil, data[:aead.NonceSize()], data[aead.NonceSize():], []byte(hash))
}
func (s *Store) List() ([]map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(s.Dir)
	if os.IsNotExist(err) {
		return []map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	result := []map[string]string{}
	for _, entry := range entries {
		hash := strings.TrimSuffix(entry.Name(), ".enc")
		if !strings.HasSuffix(entry.Name(), ".enc") || !hashPattern.MatchString(hash) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.Dir, "packages", hash, "manifest.json"))
		if err != nil {
			return nil, err
		}
		var manifest struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		}
		if err = json.Unmarshal(data, &manifest); err != nil {
			return nil, err
		}
		result = append(result, map[string]string{"sha256": hash, "name": manifest.Name, "version": manifest.Version})
	}
	return result, nil
}
