package local

import (
	"context"
	"fmt"
	"mcplatform/connector/internal/local/model"
	"mcplatform/connector/internal/network"
)

func (s *Service) networkRequest(ctx context.Context, r model.Request, remote bool) (any, error) {
	if remote {
		return nil, fmt.Errorf("device network settings can only be accessed on this device")
	}
	if s.options.Network == nil {
		return nil, fmt.Errorf("local network settings unavailable")
	}
	switch r.Action {
	case "network.get":
		return s.options.Network.View(), nil
	case "network.save":
		input, err := network.ParseSave(r.Content)
		if err != nil {
			return nil, err
		}
		view, err := s.options.Network.Save(input)
		if err == nil {
			s.mu.Lock()
			notify := s.notifierLocked()
			s.mu.Unlock()
			if notify != nil {
				notify()
			}
		}
		return view, err
	case "network.check":
		return network.Check(ctx, s.options.Network, s.options.NetworkClient), nil
	default:
		return nil, fmt.Errorf("unknown network action")
	}
}
