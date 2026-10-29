package local

import (
	"fmt"
	"mcplatform/connector/internal/local/documents"
	"mcplatform/connector/internal/local/model"
	"mcplatform/connector/internal/local/sources"
)

func (s *Service) background(request model.Request, remote bool) {
	var result any
	var err error
	if request.Action == "scan" {
		result, err = s.longScan()
	} else {
		result, err = s.run(s.ctx, request)
	}
	s.mu.Lock()
	op := s.state.Operations[request.OperationID]
	if err != nil {
		op.Phase = "failed"
		op.Error = err.Error()
		if request.Action != "scan" {
			op.Error = "MCP operation failed; inspect local connector diagnostics"
		}
		s.options.Error(err)
	} else {
		op.Phase = "succeeded"
		op.Result = documents.Encode(result)
	}
	s.state.Operations[op.ID] = op
	s.state.Revision++
	saveErr := s.options.Store.Save(s.state)
	notify := s.notifierLocked()
	s.mu.Unlock()
	if saveErr != nil {
		s.options.Error(saveErr)
	} else if notify != nil {
		notify()
	}
}
func (s *Service) longScan() (any, error) {
	s.mu.Lock()
	revision := s.state.Revision
	list := append([]model.Source{}, s.state.Sources...)
	s.mu.Unlock()
	resources, issues := sources.Scan(s.ctx, list)
	s.mu.Lock()
	defer s.mu.Unlock()
	if revision != s.state.Revision {
		return nil, fmt.Errorf("REVISION_CONFLICT: sources changed during scan; scan again")
	}
	s.mergeScan(resources, issues)
	return map[string]any{"issues": issues}, nil
}
