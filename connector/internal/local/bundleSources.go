package local

import (
	"context"
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/local/documents"
	"mcplatform/connector/internal/local/model"
	"mcplatform/connector/internal/local/sources"
	"mcplatform/connector/internal/local/storage"
	"mcplatform/connector/internal/mcpclient"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// Only the public wrapper is inventoried/synchronized; the launch config stays encrypted.
func (s *Service) refreshBundles(ctx context.Context) error {
	if s.options.Bundles == nil {
		return nil
	}
	items, err := s.options.Bundles.List()
	if err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	entries := map[string]any{}
	for _, item := range items {
		descriptor, err := s.options.Bundles.Descriptor(item["sha256"], executable)
		if err != nil {
			return err
		}
		descriptor["description"] = item["name"] + " · " + item["version"]
		entries["mcpb-"+item["sha256"]] = descriptor
	}
	path := filepath.Join(s.options.Bundles.Dir, "clients.json")
	if err := os.MkdirAll(s.options.Bundles.Dir, 0700); err != nil {
		return err
	}
	if err := storage.Atomic(path, documents.Encode(map[string]any{"mcpServers": entries}), 0600); err != nil {
		return err
	}
	s.addSources([]model.Source{sources.New("mcpb", "mcp", path, "")})
	s.scan(ctx)
	return nil
}

func (s *Service) bundleResource(hash string) (model.Resource, error) {
	path := filepath.Join(s.options.Bundles.Dir, "clients.json")
	for _, resource := range s.state.Resources {
		if resource.Path == path && resource.Name == "mcpb-"+hash && !resource.Deleted {
			return resource, nil
		}
	}
	return model.Resource{}, fmt.Errorf("local MCPB resource missing; reload the local inventory")
}

func (s *Service) bundleMutation(ctx context.Context, work func() (any, error)) (any, error) {
	s.mu.Lock()
	var notify func()
	defer func() {
		s.mu.Unlock()
		if notify != nil {
			notify()
		}
	}()
	result, err := work()
	if err != nil {
		return nil, err
	}
	if err = s.refreshBundles(ctx); err != nil {
		return nil, fmt.Errorf("MCPB configuration saved but inventory refresh failed: %w", err)
	}
	s.state.Revision++
	if err = s.options.Store.Save(s.state); err != nil {
		return nil, err
	}
	notify = s.notifierLocked()
	return result, nil
}

// Resolve into the existing local MCP manager only at dispatch time, so its diagnostic
// redaction sees the real credentials without persisting or synchronizing plaintext.
func (s *Service) resourceRuntime(resource model.Resource, source model.Source) (mcpclient.Config, error) {
	entry, err := documents.Object(resource.Content)
	if err != nil {
		return mcpclient.Config{}, err
	}
	config, err := sources.Runtime(entry, source)
	if err != nil || s.options.Bundles == nil || source.Client != "mcpb" {
		return config, err
	}
	executable, err := os.Executable()
	if err != nil {
		return config, err
	}
	hash := strings.TrimPrefix(resource.Name, "mcpb-")
	if resource.Path != filepath.Join(s.options.Bundles.Dir, "clients.json") || len(config.Args) != 7 || config.Command != executable {
		return config, fmt.Errorf("MCPB resource changed; restore it from the local MCPB panel")
	}
	revision := config.Args[6]
	expected := []string{"bundle-stdio", "--data-dir", s.options.Bundles.Dir, "--sha256", hash, "--revision", revision}
	if !slices.Equal(config.Args, expected) {
		return config, fmt.Errorf("MCPB client entry changed; restore it from the local MCPB panel")
	}
	raw, err := s.options.Bundles.ConfigurationAt(hash, revision)
	if err != nil {
		return config, err
	}
	var launch mcpclient.Config
	if err = json.Unmarshal(raw, &launch); err != nil {
		return config, err
	}
	return launch, nil
}
