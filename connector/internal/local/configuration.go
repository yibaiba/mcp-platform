package local

import (
	"fmt"
	"mcplatform/connector/internal/local/documents"
	"mcplatform/connector/internal/local/model"
	"os"
	"path/filepath"
)

type configurationInput struct {
	Data    []byte
	Mode    os.FileMode
	Missing bool
}

func readConfiguration(r model.Resource, format string) (configurationInput, error) {
	data, err := os.ReadFile(r.RealPath)
	if os.IsNotExist(err) && r.Deleted {
		input := configurationInput{Data: []byte("{}"), Mode: 0600, Missing: true}
		if format == "toml" {
			input.Data = []byte{}
		}
		return input, verifyConfiguration(r, input)
	}
	if err != nil {
		return configurationInput{}, err
	}
	if documents.Digest(data) != r.FileDigest {
		return configurationInput{}, fmt.Errorf("SOURCE_CONFLICT: configuration file changed")
	}
	info, err := os.Stat(r.RealPath)
	if err != nil {
		return configurationInput{}, err
	}
	return configurationInput{Data: data, Mode: info.Mode().Perm()}, nil
}
func verifyConfiguration(r model.Resource, input configurationInput) error {
	latest, err := os.ReadFile(r.RealPath)
	if input.Missing {
		if !os.IsNotExist(err) {
			return fmt.Errorf("SOURCE_CONFLICT: configuration was recreated during restoration")
		}
		parent, err := filepath.EvalSymlinks(filepath.Dir(r.Path))
		if err != nil || filepath.Join(parent, filepath.Base(r.Path)) != r.RealPath {
			return fmt.Errorf("SOURCE_CONFLICT: missing source target changed")
		}
		return nil
	}
	if err != nil {
		return err
	}
	real, err := filepath.EvalSymlinks(r.Path)
	if err != nil || real != r.RealPath {
		return fmt.Errorf("SOURCE_CONFLICT: symlink target changed")
	}
	if documents.Digest(latest) != documents.Digest(input.Data) {
		return fmt.Errorf("SOURCE_CONFLICT: configuration changed during write preparation")
	}
	return nil
}
