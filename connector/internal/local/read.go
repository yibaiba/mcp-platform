package local

import (
	"fmt"
	"mcplatform/connector/internal/local/documents"
	"mcplatform/connector/internal/local/model"
)

func (s *Service) read(request model.Request, remote bool) (any, error) {
	if request.Action == "state" {
		s.runtimeStatus()
		return s.view(remote), nil
	}
	if request.Action == "backup" {
		if remote {
			return nil, fmt.Errorf("backups are available only in the local page")
		}
		op, ok := s.state.Operations[request.ID]
		if !ok {
			return nil, fmt.Errorf("operation not found")
		}
		r, ok := s.state.Resources[op.ResourceID]
		if !ok {
			return nil, fmt.Errorf("resource not found")
		}
		return s.restoreContent(model.Request{Content: documents.Encode(map[string]string{"operationId": op.ID})}, r)
	}
	if request.Action == "operation" {
		op, ok := s.state.Operations[request.ID]
		if !ok {
			return nil, fmt.Errorf("operation not found")
		}
		if remote {
			op.Backup = ""
			op.Target = ""
			op.Staged = ""
		}
		return op, nil
	}
	if request.Action == "resource" {
		r, ok := s.state.Resources[request.ID]
		if !ok {
			return nil, fmt.Errorf("resource not found")
		}
		if remote {
			r = Redact(r)
		}
		return r, nil
	}
	return nil, fmt.Errorf("unsupported read action")
}
