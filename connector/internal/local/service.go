package local

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mcplatform/connector/internal/bundles"
	"mcplatform/connector/internal/local/documents"
	"mcplatform/connector/internal/local/model"
	"mcplatform/connector/internal/local/sources"
	"mcplatform/connector/internal/local/storage"
	"mcplatform/connector/internal/network"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type Runtime interface {
	Execute(context.Context, string, json.RawMessage) (any, error)
	Close(string) error
	Status() []map[string]string
}
type Options struct {
	Bundles       *bundles.Store
	Network       *network.Store
	NetworkClient *http.Client
	SyncTarget    string
	Store         storage.Store
	Locations     sources.Locations
	Runtime       Runtime
	Error         func(error)
	Changed       func(string) error
}
type Service struct {
	mu             sync.Mutex
	state          model.State
	options        Options
	ctx            context.Context
	onchange       func()
	subscribers    map[uint64]func()
	nextSubscriber uint64
	workers        sync.WaitGroup
	active         map[string]context.CancelFunc
}

func New(ctx context.Context, options Options) (*Service, error) {
	state, err := options.Store.Load()
	if err != nil {
		return nil, err
	}
	if options.SyncTarget != "" {
		if state.SyncTarget != "" && state.SyncTarget != options.SyncTarget {
			return nil, fmt.Errorf("local selections belong to another platform device; use a separate --data-dir for this device")
		}
		state.SyncTarget = options.SyncTarget
	}
	if err = options.Store.Recover(&state); err != nil {
		return nil, err
	}
	if !state.Initialized && len(state.Sources) == 0 {
		state.Sources = sources.User(options.Locations)
	}
	state.Initialized = true
	service := &Service{state: state, options: options, ctx: ctx, active: map[string]context.CancelFunc{}}
	if err = service.refreshBundles(ctx); err != nil {
		return nil, err
	}
	service.scan(ctx)
	if err = options.Store.Save(service.state); err != nil {
		return nil, err
	}
	return service, nil
}
func (s *Service) SetNotifier(notify func()) { s.mu.Lock(); defer s.mu.Unlock(); s.onchange = notify }
func (s *Service) Watch(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.mu.Lock()
			before := documents.Digest(documents.Encode(s.state.Resources))
			s.scan(ctx)
			changed := before != documents.Digest(documents.Encode(s.state.Resources))
			var err error
			if changed {
				s.state.Revision++
				err = s.options.Store.Save(s.state)
			}
			notify := s.notifierLocked()
			s.mu.Unlock()
			if err != nil {
				s.options.Error(err)
			}
			if changed && err == nil && notify != nil {
				notify()
			}
		}
	}
}
func (s *Service) scan(ctx context.Context) {
	resources, issues := sources.Scan(ctx, s.state.Sources)
	s.mergeScan(resources, issues)
}
func (s *Service) mergeScan(resources map[string]model.Resource, issues []string) {
	for id, old := range s.state.Resources {
		if current, ok := resources[id]; ok {
			current.Selected = old.Selected
			current.Runtime = old.Runtime
			if current.Digest != old.Digest || current.Deleted != old.Deleted {
				if current.Kind == "mcp" {
					if err := s.invalidate(id); err != nil {
						current.Issues = append(current.Issues, "Failed to close changed MCP sessions")
						s.options.Error(err)
					}
				}
			}
			current.ReloadRequired = old.ReloadRequired || current.Digest != old.Digest
			resources[id] = current
			continue
		}
		// Unreadable or malformed sources are not deletion events.
		old.Issues = s.resourceIssues(old, issues)
		if len(old.Issues) == 0 {
			if !old.Deleted && old.Kind == "mcp" {
				if err := s.invalidate(id); err != nil {
					s.options.Error(err)
					old.Issues = append(old.Issues, "Failed to close deleted MCP sessions")
				}
			}
			old.Deleted = true
			if data, err := os.ReadFile(old.RealPath); err == nil {
				old.FileDigest = documents.Digest(data)
			}
		}
		resources[id] = old
	}
	s.state.Resources = resources
	s.state.Issues = issues
}
func (s *Service) Execute(ctx context.Context, request model.Request, remote bool) (any, error) {
	if strings.HasPrefix(request.Action, "mcpb.") {
		return s.bundleRequest(ctx, request, remote)
	}
	if strings.HasPrefix(request.Action, "network.") {
		return s.networkRequest(ctx, request, remote)
	}
	s.mu.Lock()
	defer func() {
		notify := s.notifierLocked()
		s.mu.Unlock()
		if request.OperationID != "" && notify != nil {
			notify()
		}
	}()
	if err := s.ctx.Err(); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	switch request.Action {
	case "state", "backup", "operation", "resource":
		return s.read(request, remote)
	}
	return s.executeWrite(ctx, request, remote)
}
func (s *Service) executeWrite(ctx context.Context, request model.Request, remote bool) (any, error) {
	if request.OperationID == "" {
		return nil, fmt.Errorf("operationId is required")
	}
	fingerprint := documents.Digest(documents.Encode(request))
	if op, ok := s.state.Operations[request.OperationID]; ok {
		if op.RequestDigest != fingerprint {
			return nil, fmt.Errorf("idempotency key was already used with different input")
		}
		return publicOperation(op, remote), nil
	}
	if request.ExpectedRevision != s.state.Revision {
		return nil, fmt.Errorf("REVISION_CONFLICT: local inventory changed; reload before editing")
	}
	op := model.Operation{ID: request.OperationID, Action: request.Action, ResourceID: request.ID, RequestDigest: fingerprint, Phase: "running", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	s.state.Operations[op.ID] = op
	if err := s.options.Store.Save(s.state); err != nil {
		return nil, err
	}
	if request.Action == "scan" || request.Action == "start" || request.Action == "stop" {
		s.workers.Add(1)
		go func() { defer s.workers.Done(); s.background(request, remote) }()
		return publicOperation(op, remote), nil
	}
	result, err := s.mutate(ctx, mutation{Request: request, Remote: remote, Operation: &op})
	if err != nil {
		op.Phase = "failed"
		op.Error = err.Error()
	} else {
		op.Phase = "succeeded"
		op.Result = documents.Encode(result)
		s.state.Revision++
	}
	s.state.Operations[op.ID] = op
	if saveErr := s.options.Store.Save(s.state); saveErr != nil {
		return nil, saveErr
	}
	if err != nil {
		return nil, err
	}
	return publicOperation(op, remote), nil
}
func publicOperation(op model.Operation, remote bool) model.Operation {
	if remote {
		op.Backup = ""
		op.Target = ""
		op.Staged = ""
	}
	return op
}
func (s *Service) view(remote bool) model.State {
	data := documents.Encode(s.state)
	var result model.State
	_ = json.Unmarshal(data, &result)
	if remote {
		result.IdentityResources = map[string]string{}
		for id, r := range result.Resources {
			result.Resources[id] = Redact(r)
		}
		for id, op := range result.Operations {
			result.Operations[id] = publicOperation(op, true)
		}
	}
	return result
}

func (s *Service) resourceIssues(resource model.Resource, issues []string) []string {
	result := []string{}
	for _, source := range s.state.Sources {
		for _, id := range resource.SourceIDs {
			if source.ID != id {
				continue
			}
			for _, issue := range issues {
				if strings.HasPrefix(issue, source.Path+":") || strings.HasPrefix(issue, resource.Path+":") {
					result = append(result, issue)
				}
			}
		}
	}
	return result
}

func (s *Service) invalidate(id string) error {
	if cancel := s.active[id]; cancel != nil {
		cancel()
	}
	result := s.options.Runtime.Close(runtimeID(id))
	if s.options.Changed != nil {
		result = errors.Join(result, s.options.Changed(id))
	}
	return result
}
