package storage

import (
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/files"
	"mcplatform/connector/internal/local/documents"
	"mcplatform/connector/internal/local/model"
	"mcplatform/connector/internal/local/sources"
	"os"
	"path/filepath"
)

type Store struct{ Dir string }

func (s Store) Load() (model.State, error) {
	state := model.State{Revision: 1, Initialized: false, IdentityResources: map[string]string{}, Sources: []model.Source{}, Resources: map[string]model.Resource{}, Operations: map[string]model.Operation{}, Issues: []string{}}
	data, err := os.ReadFile(filepath.Join(s.Dir, "manifest.json"))
	if os.IsNotExist(err) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	if err = json.Unmarshal(data, &state); err != nil {
		return state, fmt.Errorf("local manifest is invalid; restore the local backup: %w", err)
	}
	if state.Resources == nil || state.Operations == nil || state.Revision < 1 {
		return state, fmt.Errorf("invalid local manifest structure")
	}
	if state.IdentityResources == nil {
		state.IdentityResources = map[string]string{}
	}
	return state, nil
}
func (s Store) Save(state model.State) error {
	if err := os.MkdirAll(s.Dir, 0700); err != nil {
		return err
	}
	return Atomic(filepath.Join(s.Dir, "manifest.json"), documents.Encode(state), 0600)
}
func Atomic(path string, data []byte, mode os.FileMode) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".local-stage-")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if err = file.Chmod(mode); err == nil {
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
	return os.Rename(name, path)
}
func (s Store) Backup(id string, data []byte) (string, error) {
	dir := filepath.Join(s.Dir, "backups")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, documents.Digest([]byte(id))+".json")
	return path, Atomic(path, data, 0600)
}
func (s Store) Recover(state *model.State) error {
	for id, op := range state.Operations {
		if op.Phase != "prepared" {
			continue
		}
		var digest string
		if op.Staged != "" {
			if _, err := os.Stat(op.Target); os.IsNotExist(err) {
				if _, err := os.Stat(op.Staged + ".previous"); err == nil && op.Action != "delete" {
					if err = os.Rename(op.Staged+".previous", op.Target); err != nil {
						return err
					}
				}
			}
			tree, err := sources.ReadSkill(op.Target)
			if os.IsNotExist(err) {
				tree = map[string][]byte{}
			} else if err != nil {
				return err
			}
			digest = files.Digest(tree)
		} else {
			actual, err := os.ReadFile(op.Target)
			if err != nil && !os.IsNotExist(err) {
				return err
			}
			digest = documents.Digest(actual)
		}
		switch digest {
		case op.AfterDigest:
			op.Phase = "succeeded"
		case op.BeforeDigest:
			op.Phase = "interrupted"
			op.Error = "Write interrupted before commit; backup retained; rescan before retry"
		default:
			op.Phase = "conflict"
			op.Error = "Target changed during interrupted write; backup retained"
		}
		state.Operations[id] = op
	}
	for id, op := range state.Operations {
		if op.Phase == "running" {
			op.Phase = "interrupted"
			op.Error = "Connector restarted; operation outcome must be checked before retry"
			state.Operations[id] = op
		}
	}
	return s.Save(*state)
}
