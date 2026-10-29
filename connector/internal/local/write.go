package local

import (
	"context"
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/files"
	"mcplatform/connector/internal/local/documents"
	"mcplatform/connector/internal/local/model"
	"mcplatform/connector/internal/local/sources"
	"mcplatform/connector/internal/local/storage"
	"os"
	"path/filepath"
)

func (s *Service) write(ctx context.Context, input mutation) (any, error) {
	request, remote, op := input.Request, input.Remote, input.Operation
	s.scan(ctx)
	resource, ok := s.state.Resources[request.ID]
	if !ok {
		return nil, fmt.Errorf("resource not found")
	}
	if s.options.Bundles != nil && resource.Path == filepath.Join(s.options.Bundles.Dir, "clients.json") {
		return nil, fmt.Errorf("manage MCPB configuration in the local MCPB panel")
	}
	if resource.ReadOnly {
		return nil, fmt.Errorf("resource is read-only")
	}
	if request.ExpectedDigest == "" || request.ExpectedDigest != resource.Digest {
		return nil, fmt.Errorf("SOURCE_CONFLICT: resource changed; review the new diff")
	}
	if request.Action == "delete" && !request.Confirm {
		return nil, fmt.Errorf("deletion requires confirmation")
	}
	if request.Action == "restore" && remote {
		return nil, fmt.Errorf("restore backups from the local page")
	}
	content := request.Content
	var err error
	if remote && resource.Kind == "mcp" && request.Action != "delete" {
		content, err = hydrate(resource, content)
		if err != nil {
			return nil, err
		}
	}
	if request.Action == "restore" {
		backup, err := s.restoreContent(request, resource)
		if err != nil {
			return nil, err
		}
		content = backup
	}
	if cancel := s.active[resource.ID]; cancel != nil {
		cancel()
	}
	if err = s.options.Runtime.Close(runtimeID(resource.ID)); err != nil {
		return nil, err
	}
	if resource.Kind == "skill" {
		err = s.writeSkill(resource, content, request, op)
	} else {
		err = s.writeMCP(resource, content, request, op)
	}
	if err != nil {
		return nil, err
	}
	s.scan(ctx)
	r := s.state.Resources[resource.ID]
	r.ReloadRequired = true
	r.LoadedVerified = false
	s.state.Resources[r.ID] = r
	return map[string]any{"digest": r.Digest, "reloadRequired": true, "loadedVerified": false}, nil
}
func (s *Service) restoreContent(request model.Request, resource model.Resource) (json.RawMessage, error) {
	var input struct {
		OperationID string `json:"operationId"`
	}
	if err := json.Unmarshal(request.Content, &input); err != nil {
		return nil, err
	}
	op, ok := s.state.Operations[input.OperationID]
	if !ok || op.ResourceID != resource.ID || op.Backup == "" {
		return nil, fmt.Errorf("backup not found for this resource")
	}
	data, err := os.ReadFile(op.Backup)
	if err != nil {
		return nil, err
	}
	if resource.Kind == "skill" {
		return data, nil
	}
	source, err := s.source(resource)
	if err != nil {
		return nil, err
	}
	root, err := documents.Parse(data, source.Format)
	if err != nil {
		return nil, err
	}
	value, ok := documents.At(root, resource.Pointer)
	if !ok {
		return nil, fmt.Errorf("backup does not contain this entry")
	}
	return documents.Encode(value), nil
}
func (s *Service) writeMCP(resource model.Resource, content json.RawMessage, request model.Request, op *model.Operation) error {
	source, err := s.source(resource)
	if err != nil {
		return err
	}
	input, err := readConfiguration(resource, source.Format)
	if err != nil {
		return err
	}
	data := input.Data
	var next any
	if request.Action != "delete" {
		object, err := documents.Object(content)
		if err != nil {
			return err
		}
		next = object
	}
	var output []byte
	if resource.Deleted && request.Action != "delete" {
		output, err = documents.Insert(data, source.Format, resource.Pointer, next)
	} else {
		output, err = documents.Edit(data, source.Format, resource.Pointer, next)
	}
	if err != nil {
		return err
	}
	op.Backup, err = s.options.Store.Backup(op.ID, data)
	if err != nil {
		return err
	}
	op.Target = resource.RealPath
	op.BeforeDigest = documents.Digest(data)
	if input.Missing {
		op.BeforeDigest = documents.Digest(nil)
	}
	op.AfterDigest = documents.Digest(output)
	op.Phase = "prepared"
	s.state.Operations[op.ID] = *op
	if err = s.options.Store.Save(s.state); err != nil {
		return err
	}
	if err = verifyConfiguration(resource, input); err != nil {
		return err
	}
	return storage.Atomic(resource.RealPath, output, input.Mode)

}
func (s *Service) writeSkill(resource model.Resource, content json.RawMessage, request model.Request, op *model.Operation) error {
	before := map[string][]byte{}
	var err error
	if !resource.Deleted {
		before, err = sources.ReadSkill(resource.RealPath)
		if err != nil {
			return err
		}
		if files.Digest(before) != resource.FileDigest {
			return fmt.Errorf("SOURCE_CONFLICT: skill directory changed")
		}
	}
	op.Backup, err = s.options.Store.Backup(op.ID, sources.SkillContent(before))
	if err != nil {
		return err
	}
	after := map[string][]byte{}
	if request.Action != "delete" {
		after, err = sources.DecodeSkill(content)
		if err != nil {
			return err
		}
	}
	stage, err := os.MkdirTemp(filepath.Dir(resource.RealPath), ".local-stage-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	for relative, data := range after {
		path, err := files.SafePath(stage, relative)
		if err != nil {
			return err
		}
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		mode := os.FileMode(0600)
		if previous, statErr := os.Stat(filepath.Join(resource.RealPath, filepath.FromSlash(relative))); statErr == nil {
			mode = previous.Mode().Perm()
		} else if !os.IsNotExist(statErr) {
			return statErr
		}
		if err = os.WriteFile(path, data, mode); err != nil {
			return err
		}
	}
	op.Target = resource.RealPath
	op.Staged = stage
	op.BeforeDigest = files.Digest(before)
	op.AfterDigest = files.Digest(after)
	op.Phase = "prepared"
	s.state.Operations[op.ID] = *op
	if err = s.options.Store.Save(s.state); err != nil {
		return err
	}
	if !resource.Deleted {
		real, err := filepath.EvalSymlinks(resource.Path)
		if err != nil || real != resource.RealPath {
			return fmt.Errorf("SOURCE_CONFLICT: skill symlink target changed")
		}
		current, err := sources.ReadSkill(resource.RealPath)
		if err != nil {
			return err
		}
		if files.Digest(current) != op.BeforeDigest {
			return fmt.Errorf("SOURCE_CONFLICT: skill changed during write preparation")
		}
		if err = os.Rename(resource.RealPath, stage+".previous"); err != nil {
			return err
		}
	}
	if request.Action != "delete" {
		if err = os.Rename(stage, resource.RealPath); err != nil {
			if !resource.Deleted {
				return fmt.Errorf("skill replacement failed: %w; previous files at %s", err, stage+".previous")
			}
			return err
		}
	}
	return nil
}
