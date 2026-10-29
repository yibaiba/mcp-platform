package local

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/network"
)

func (s *Service) CheckPackage(ctx context.Context, raw json.RawMessage) (any, error) {
	resolved, err := s.Resolve(raw)
	if err != nil {
		return nil, err
	}
	var input struct {
		Config network.Command `json:"config"`
	}
	if err = json.Unmarshal(resolved, &input); err != nil {
		return nil, err
	}
	if s.options.Network == nil || s.options.NetworkClient == nil {
		return nil, fmt.Errorf("device network service unavailable")
	}
	result, err := network.CheckPackage(ctx, input.Config, s.options.Network, s.options.NetworkClient)
	if err != nil {
		return nil, err
	}
	current, err := s.Resolve(raw)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(resolved, current) {
		return nil, fmt.Errorf("local resource changed during package check")
	}
	return result, nil
}
