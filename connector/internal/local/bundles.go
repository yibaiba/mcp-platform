package local

import (
	"context"
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/local/documents"
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
		return s.options.Bundles.Install(request.Content)
	case "mcpb.list":
		return s.options.Bundles.List()
	case "mcpb.start", "mcpb.stop":
		if remote {
			return nil, fmt.Errorf("start local bundle from this device")
		}
		id := "bundle-" + request.ID
		if request.Action == "mcpb.stop" {
			return map[string]bool{"stopped": true}, s.options.Runtime.Close(id)
		}
		config, err := s.options.Bundles.Configuration(request.ID)
		if err != nil {
			return nil, err
		}
		return s.options.Runtime.Execute(ctx, "catalog", documents.Encode(map[string]any{"connectionId": id, "config": json.RawMessage(config)}))
	default:
		return nil, fmt.Errorf("unsupported MCPB operation")
	}
}
