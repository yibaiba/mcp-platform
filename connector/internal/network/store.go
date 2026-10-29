package network

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/local/storage"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
)

type disk struct {
	Revision int    `json:"revision"`
	Config   Config `json:"config"`
}
type Store struct {
	mu      sync.Mutex
	Dir     string
	changed func()
	state   disk
	aead    cipher.AEAD
}

func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	key, err := loadKey(dir)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	s := &Store{Dir: dir, aead: aead, state: disk{Config: Config{Secrets: map[string]string{}}}}
	data, err := os.ReadFile(filepath.Join(dir, "network.enc"))
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if len(data) < aead.NonceSize() {
		return nil, fmt.Errorf("invalid encrypted network settings")
	}
	plain, err := aead.Open(nil, data[:aead.NonceSize()], data[aead.NonceSize():], []byte("device-network"))
	if err != nil {
		return nil, fmt.Errorf("network settings decryption failed")
	}
	if err = json.Unmarshal(plain, &s.state); err != nil {
		return nil, err
	}
	return s, s.state.Config.Settings.Validate()
}
func (s *Store) Snapshot() (Config, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.state.Config
	c.Secrets = map[string]string{}
	for k, v := range s.state.Config.Secrets {
		c.Secrets[k] = v
	}
	return c, s.state.Revision
}
func (s *Store) View() View {
	c, rev := s.Snapshot()
	view := View{Revision: rev, Settings: c.Settings, Secrets: map[string]bool{}}
	for _, name := range SecretNames {
		view.Secrets[name] = c.Secrets[name] != ""
	}
	return view
}
func (s *Store) Save(input Save) (View, error) {
	if err := s.save(input); err != nil {
		return View{}, err
	}
	return s.View(), nil
}
func (s *Store) save(input Save) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if input.Revision != s.state.Revision {
		return fmt.Errorf("REVISION_CONFLICT: reload network settings")
	}
	if err := input.Settings.Validate(); err != nil {
		return err
	}
	next := disk{Revision: input.Revision + 1, Config: Config{Settings: input.Settings, Secrets: map[string]string{}}}
	secrets, err := editSecrets(s.state.Config.Secrets, input.Secrets)
	if err != nil {
		return err
	}
	next.Config.Secrets = secrets
	plain, err := json.Marshal(next)
	if err != nil {
		return err
	}
	nonce := make([]byte, s.aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return err
	}
	data := s.aead.Seal(nonce, nonce, plain, []byte("device-network"))
	if err = storage.Atomic(filepath.Join(s.Dir, "network.enc"), data, 0600); err != nil {
		return err
	}
	s.state = next
	return nil
}

// Publish a complete key without overwriting a key created by another process.
func createKey(path string, key []byte) ([]byte, error) {
	staged, err := os.CreateTemp(filepath.Dir(path), ".network-key-")
	if err != nil {
		return nil, err
	}
	defer os.Remove(staged.Name())
	if _, err = staged.Write(key); err == nil {
		err = staged.Sync()
	}
	closeErr := staged.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if err = os.Link(staged.Name(), path); err != nil && !os.IsExist(err) {
		return nil, err
	}
	return os.ReadFile(path)
}

func loadKey(dir string) ([]byte, error) {
	keyPath := filepath.Join(dir, "network.key")
	key, err := os.ReadFile(keyPath)
	if os.IsNotExist(err) {
		if _, statErr := os.Stat(filepath.Join(dir, "network.enc")); statErr == nil {
			return nil, fmt.Errorf("network key missing; restore original key")
		}
		key = make([]byte, 32)
		if _, err = rand.Read(key); err != nil {
			return nil, err
		}
		key, err = createKey(keyPath, key)
		if err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	return key, nil
}

func editSecrets(current map[string]string, edits map[string]Edit) (map[string]string, error) {
	secrets := map[string]string{}
	for k, v := range current {
		secrets[k] = v
	}
	for name, edit := range edits {
		if !slices.Contains(SecretNames, name) {
			return nil, fmt.Errorf("unknown credential")
		}
		switch edit.Action {
		case "keep":
		case "clear":
			delete(secrets, name)
		case "replace":
			if edit.Value == "" || strings.ContainsAny(edit.Value, "\r\n") {
				return nil, fmt.Errorf("invalid credential")
			}
			secrets[name] = edit.Value
		default:
			return nil, fmt.Errorf("invalid credential edit action")
		}
	}
	return secrets, nil
}
