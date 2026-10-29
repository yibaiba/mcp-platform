package local

import (
	"context"
	"fmt"
	"mcplatform/connector/internal/local/documents"
	"mcplatform/connector/internal/local/model"
	"mcplatform/connector/internal/local/sources"
	"mcplatform/connector/internal/mcpclient"
)

type mutation struct {
	Request   model.Request
	Remote    bool
	Operation *model.Operation
}

func (s *Service) mutate(ctx context.Context, input mutation) (any, error) {
	r, remote := input.Request, input.Remote
	switch r.Action {
	case "identity.bind":
		if remote {
			return nil, fmt.Errorf("identity bindings must be edited in the local page")
		}
		resource, ok := s.state.Resources[r.ID]
		if !ok || resource.Kind != "mcp" || !resource.Selected {
			return nil, fmt.Errorf("choose a selected MCP resource for this identity")
		}
		if r.Identity == "" || r.Identity == "default" {
			return nil, fmt.Errorf("dedicated binding ID is required")
		}
		s.state.IdentityResources[r.Identity] = r.ID
		return map[string]bool{"bound": true}, nil
	case "project.add":
		list, err := sources.Project(s.options.Locations.Home, r.Project)
		if err != nil {
			return nil, err
		}
		s.addSources(list)
		return map[string]bool{"added": true}, nil
	case "source.add":
		if r.Source == nil {
			return nil, fmt.Errorf("source is required")
		}
		if err := sources.Validate(*r.Source); err != nil {
			return nil, err
		}
		source := *r.Source
		source.ID = sources.ID(source.Client, source.Kind, source.Path, documents.Pointer(source.Pointer))
		s.addSources([]model.Source{source})
		return source, nil
	case "source.remove":
		for _, resource := range s.state.Resources {
			if resource.Selected {
				for _, id := range resource.SourceIDs {
					if id == r.ID {
						return nil, fmt.Errorf("unlink selected resources before removing their source")
					}
				}
			}
		}
		list := []model.Source{}
		for _, source := range s.state.Sources {
			if source.ID != r.ID {
				list = append(list, source)
			}
		}
		s.state.Sources = list
		return map[string]bool{"removed": true}, nil
	case "select":
		resource, ok := s.state.Resources[r.ID]
		if !ok {
			return nil, fmt.Errorf("resource not found")
		}
		if resource.ReadOnly && r.Selected {
			return nil, fmt.Errorf("vendor or system managed resource is read-only")
		}
		if !r.Selected && s.options.Changed != nil {
			if err := s.options.Changed(resource.ID); err != nil {
				return nil, err
			}
		}
		resource.Selected = r.Selected
		s.state.Resources[r.ID] = resource
		return map[string]bool{"selected": r.Selected}, nil
	case "edit", "delete", "restore":
		return s.write(ctx, input)
	default:
		return nil, fmt.Errorf("unsupported local action: %s", r.Action)
	}
}
func (s *Service) addSources(list []model.Source) {
	for _, source := range list {
		found := false
		for _, old := range s.state.Sources {
			if old.ID == source.ID {
				found = true
				break
			}
		}
		if !found {
			s.state.Sources = append(s.state.Sources, source)
		}
	}
}
func (s *Service) source(resource model.Resource) (model.Source, error) {
	for _, source := range s.state.Sources {
		for _, id := range resource.SourceIDs {
			if id == source.ID {
				return source, nil
			}
		}
	}
	return model.Source{}, fmt.Errorf("resource source missing")
}
func (s *Service) run(ctx context.Context, request model.Request) (any, error) {
	s.mu.Lock()
	r, ok := s.state.Resources[request.ID]
	if !ok || r.Kind != "mcp" || r.Deleted {
		s.mu.Unlock()
		return nil, fmt.Errorf("MCP resource not found")
	}
	if request.Action == "stop" {
		if cancel := s.active[r.ID]; cancel != nil {
			cancel()
		}
		s.mu.Unlock()
		return map[string]bool{"stopped": true}, s.options.Runtime.Close(runtimeID(r.ID))
	}
	if _, running := s.active[r.ID]; running {
		s.mu.Unlock()
		return nil, fmt.Errorf("connection operation already running")
	}
	if r.ReadOnly {
		s.mu.Unlock()
		return nil, fmt.Errorf("resource is read-only")
	}
	source, err := s.source(r)
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	entry, err := documents.Object(r.Content)
	if err != nil {
		return nil, err
	}
	config, err := sources.Runtime(entry, source)
	if err != nil {
		return nil, err
	}
	config.DeviceResourceID = r.ID
	callCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	s.mu.Lock()
	s.active[r.ID] = cancel
	r.Runtime = "connecting"
	s.state.Resources[r.ID] = r
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.active, r.ID); s.mu.Unlock() }()
	return s.options.Runtime.Execute(callCtx, "catalog", documents.Encode(mcpclient.Params{ConnectionID: runtimeID(r.ID), Config: config}))
}
func runtimeID(id string) string {
	return fmt.Sprintf("%s-%s-4%s-8%s-%s", id[:8], id[8:12], id[13:16], id[17:20], id[20:32])
}
func (s *Service) runtimeStatus() {
	if len(s.active) > 0 {
		return
	}
	statuses := map[string]string{}
	for _, status := range s.options.Runtime.Status() {
		statuses[status["id"]] = status["status"]
	}
	for id, r := range s.state.Resources {
		r.Runtime = "client-managed"
		if status, ok := statuses[runtimeID(id)]; ok {
			r.Runtime = status
		}
		s.state.Resources[id] = r
	}
}
