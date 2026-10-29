package bundles

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mcplatform/connector/internal/files"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
)

var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type Store struct {
	Dir string
	mu  sync.Mutex
}
type Install struct {
	SHA256      string          `json:"sha256"`
	Archive     string          `json:"archive"`
	OperationID string          `json:"operationId"`
	Config      json.RawMessage `json:"config,omitempty"`
}

func (s *Store) Environment(hash string) (any, error) {
	if !hashPattern.MatchString(hash) {
		return nil, fmt.Errorf("invalid bundle digest")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	platform := runtime.GOOS
	if platform == "windows" {
		platform = "win32"
	}
	return map[string]string{"platform": platform, "home": home, "root": filepath.Join(s.Dir, "packages", hash)}, nil
}
func (s *Store) Install(raw json.RawMessage) (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var input Install
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, err
	}
	if !hashPattern.MatchString(input.SHA256) || input.OperationID == "" {
		return nil, fmt.Errorf("bundle digest and operationId are required")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(input.Archive)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != input.SHA256 {
		return nil, fmt.Errorf("bundle checksum mismatch")
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, err
	}
	root := filepath.Join(s.Dir, "packages")
	if err = os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	target := filepath.Join(root, input.SHA256)
	stage, err := os.MkdirTemp(root, ".stage-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(stage)
	if err = extract(archive, stage); err != nil {
		return nil, err
	}
	if _, err = os.Lstat(target); err == nil {
		if err = verify(archive, target); err != nil {
			return nil, err
		}
	} else if os.IsNotExist(err) {
		if err = os.Rename(stage, target); err != nil {
			return nil, err
		}
	} else {
		return nil, err
	}
	if len(input.Config) > 0 {
		if err = s.saveConfiguration(input); err != nil {
			return nil, err
		}
	}
	return map[string]any{"installed": true, "sha256": input.SHA256, "root": target}, nil
}
func extract(archive *zip.Reader, root string) error {
	seen := map[string]bool{}
	for _, entry := range archive.File {
		path, err := files.SafePath(root, strings.TrimSuffix(entry.Name, "/"))
		if err != nil {
			return err
		}
		if seen[path] {
			return fmt.Errorf("duplicate archive entry")
		}
		seen[path] = true
		if entry.Mode()&os.ModeSymlink != 0 || (!entry.Mode().IsRegular() && !entry.FileInfo().IsDir()) {
			return fmt.Errorf("archive links and special files are unsupported")
		}
		if entry.FileInfo().IsDir() {
			if err = os.MkdirAll(path, 0700); err != nil {
				return err
			}
			continue
		}
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		if err = writeEntry(entry, path); err != nil {
			return err
		}
	}
	if _, err := os.Stat(filepath.Join(root, "manifest.json")); err != nil {
		return fmt.Errorf("manifest.json missing")
	}
	return nil
}
func writeEntry(entry *zip.File, path string) error {
	reader, err := entry.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	mode := os.FileMode(0600)
	if entry.Mode()&0111 != 0 {
		mode = 0700
	}
	out, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, reader)
	syncErr := out.Sync()
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}
func verify(archive *zip.Reader, root string) error {
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("bundle directory changed")
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	for _, entry := range archive.File {
		if entry.FileInfo().IsDir() {
			continue
		}
		path, err := files.SafePath(root, strings.TrimSuffix(entry.Name, "/"))
		if err != nil {
			return err
		}
		real, err := filepath.EvalSymlinks(path)
		if err != nil || real != path {
			return fmt.Errorf("installed bundle path changed")
		}
		actual, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		reader, err := entry.Open()
		if err != nil {
			return err
		}
		expected, readErr := io.ReadAll(reader)
		reader.Close()
		if readErr != nil {
			return readErr
		}
		if !bytes.Equal(actual, expected) {
			return fmt.Errorf("installed bundle was modified")
		}
	}
	return nil
}
