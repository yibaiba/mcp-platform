package storage

import (
	"fmt"
	"os"
	"path/filepath"
)

// Acquire prevents two connector processes from overwriting the same local journal.
func (s Store) Acquire() (*os.File, error) {
	if err := os.MkdirAll(s.Dir, 0700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(s.Dir, "manager.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = lock(file); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("local management storage is already in use: %w", err)
	}
	return file, nil
}
