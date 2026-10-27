package files

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

type SkillInstaller struct {
	Roots map[string]string
	mu    sync.Mutex
}
type SkillInput struct {
	Name   string            `json:"name"`
	Files  map[string]string `json:"files"`
	Digest string            `json:"digest"`
	Target string            `json:"target"`
}

func Digest(files map[string][]byte) string {
	keys := make([]string, 0, len(files))
	for key := range files {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	hash := sha256.New()
	for _, key := range keys {
		sum := sha256.Sum256(files[key])
		fmt.Fprintf(hash, "%s\x00%x\n", key, sum)
	}
	return hex.EncodeToString(hash.Sum(nil))
}
func readTree(root string) (map[string][]byte, error) {
	result := map[string][]byte{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("user symlink conflict: %s", path)
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("special file conflict: %s", path)
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		result[filepath.ToSlash(relative)] = data
		return nil
	})
	return result, err
}
func (s *SkillInstaller) Install(raw json.RawMessage) (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var input SkillInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, err
	}
	root, ok := s.Roots[input.Target]
	if !ok {
		return nil, fmt.Errorf("skill root %q is not configured on this device", input.Target)
	}
	if strings.Contains(input.Name, "/") {
		return nil, fmt.Errorf("invalid skill name")
	}
	target, err := SafePath(root, input.Name)
	if err != nil {
		return nil, err
	}
	files := map[string][]byte{}
	for path, value := range input.Files {
		if _, err := SafePath(target, path); err != nil {
			return nil, err
		}
		data, err := base64.StdEncoding.Strict().DecodeString(value)
		if err != nil {
			return nil, err
		}
		files[path] = data
	}
	if _, ok := files["SKILL.md"]; !ok {
		return nil, fmt.Errorf("SKILL.md is required")
	}
	if Digest(files) != input.Digest {
		return nil, fmt.Errorf("skill checksum mismatch")
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	manifest, err := SafePath(root, ".platform-"+input.Name+".sha256")
	if err != nil {
		return nil, err
	}
	if err = checkExisting(target, manifest); err != nil {
		return nil, err
	}
	if err = replaceSkill(target, manifest, files); err != nil {
		return nil, err
	}
	return map[string]any{"installed": true, "digest": input.Digest, "reloadRequired": true, "loadedVerified": false}, nil
}
func checkExisting(target, manifest string) error {
	_, err := os.Lstat(target)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	previous, err := os.ReadFile(manifest)
	if err != nil {
		return fmt.Errorf("USER_CONFLICT: existing skill has no platform manifest: %w", err)
	}
	files, err := readTree(target)
	if err != nil {
		return err
	}
	if Digest(files) != string(previous) {
		return fmt.Errorf("USER_CONFLICT: local skill changed; all user files preserved")
	}
	return nil
}
func replaceSkill(target, manifest string, files map[string][]byte) error {
	stage, err := os.MkdirTemp(filepath.Dir(target), ".skill-stage-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	for relative, data := range files {
		path, err := SafePath(stage, relative)
		if err != nil {
			return err
		}
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		if err = os.WriteFile(path, data, 0600); err != nil {
			return err
		}
	}
	manifestStage, err := os.CreateTemp(filepath.Dir(target), ".manifest-stage-")
	if err != nil {
		return err
	}
	defer os.Remove(manifestStage.Name())
	if _, err = manifestStage.WriteString(Digest(files)); err != nil {
		manifestStage.Close()
		return err
	}
	if err = manifestStage.Close(); err != nil {
		return err
	}
	// Recheck after staging so edits made during preparation are preserved.
	if err = checkExisting(target, manifest); err != nil {
		return err
	}
	backup, err := os.MkdirTemp(filepath.Dir(target), ".skill-previous-")
	if err != nil {
		return err
	}
	if err = os.Remove(backup); err != nil {
		return err
	}
	existed := false
	if _, err = os.Stat(target); err == nil {
		existed = true
		if err = os.Rename(target, backup); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if err = os.Rename(stage, target); err != nil {
		if existed {
			if restore := os.Rename(backup, target); restore != nil {
				return fmt.Errorf("install failed: %v; restore failed: %v; backup: %s", err, restore, backup)
			}
		}
		return err
	}
	if err = os.Rename(manifestStage.Name(), manifest); err != nil {
		if restore := os.RemoveAll(target); restore != nil {
			return fmt.Errorf("manifest update failed: %v; cleanup failed: %v; previous files at %s", err, restore, backup)
		}
		if existed {
			if restore := os.Rename(backup, target); restore != nil {
				return fmt.Errorf("manifest update failed: %v; restore failed: %v; previous files at %s", err, restore, backup)
			}
		}
		return err
	}
	if existed {
		return os.RemoveAll(backup)
	}
	return nil
}
