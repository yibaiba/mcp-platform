package local

import (
	"context"
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/local/model"
)

func (s *Service) bundleRequest(ctx context.Context, request model.Request, remote bool) (any, error) {
	if s.options.Bundles == nil {
		return nil, fmt.Errorf("MCPB management is unavailable")
	}
	switch request.Action {
	case "mcpb.environment":
		return s.options.Bundles.Environment(request.ID)
	case "mcpb.install":
		if remote {
			var input map[string]json.RawMessage
			if err := json.Unmarshal(request.Content, &input); err != nil {
				return nil, err
			}
			if len(input["config"]) > 0 {
				return nil, fmt.Errorf("local bundle credentials must be configured on this device")
			}
		}
		if remote {
			return s.options.Bundles.Install(request.Content)
		}
		return s.bundleMutation(ctx, func() (any, error) { return s.options.Bundles.Install(request.Content) })
	case "mcpb.list":
		return s.options.Bundles.List()
	case "mcpb.remove":
		if remote {
			return nil, fmt.Errorf("remove local bundle configuration from this device")
		}
		var input struct {
			Revision string `json:"revision"`
		}
		if err := json.Unmarshal(request.Content, &input); err != nil {
			return nil, err
		}
		return s.bundleMutation(ctx, func() (any, error) {
			resource, err := s.bundleResource(request.ID)
			if err != nil {
				return nil, err
			}
			if err = s.options.Bundles.RemoveConfigurationAfterValidation(request.ID, input.Revision, func() error {
				return s.invalidate(resource.ID)
			}); err != nil {
				return nil, err
			}
			return map[string]bool{"removed": true, "packageFilesRetained": true}, nil
		})
	case "mcpb.client":
		if remote {
			return nil, fmt.Errorf("client configuration is available on this device")
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		resource, err := s.bundleResource(request.ID)
		if err != nil {
			return nil, err
		}
		return map[string]any{"mcpServers": map[string]any{resource.Name: resource.Content}}, nil
	case "mcpb.start", "mcpb.stop":
		if remote {
			return nil, fmt.Errorf("start local bundle from this device")
		}
		s.mu.Lock()
		resource, err := s.bundleResource(request.ID)
		s.mu.Unlock()
		if err != nil {
			return nil, err
		}
		action := "start"
		if request.Action == "mcpb.stop" {
			action = "stop"
		}
		return s.run(ctx, model.Request{Action: action, ID: resource.ID})
	default:
		return nil, fmt.Errorf("unsupported MCPB operation")
	}
}
