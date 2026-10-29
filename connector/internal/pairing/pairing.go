package pairing

import (
	"context"
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/agent"
	"mcplatform/connector/internal/config"
	"net/http"
	"os"
	"strings"
)

type Options struct{ Action, Path, Server, DeviceID, Code string }

func Save(ctx context.Context, client *http.Client, options Options) (config.Config, error) {
	cfg, fields, err := prepare(options)
	if err != nil {
		return cfg, err
	}
	var next config.Config
	if options.Action == "re-pair" {
		next, err = agent.RePair(ctx, client, agent.RePairInput{Config: cfg, Code: strings.TrimSpace(options.Code)})
	} else {
		next, err = agent.Pair(ctx, client, cfg.Server, strings.TrimSpace(options.Code))
	}
	if err != nil {
		return cfg, err
	}
	if options.Action == "re-pair" {
		err = config.ReplaceCredentials(options.Path, fields, next)
	} else {
		err = config.Save(options.Path, next)
	}
	if err != nil {
		return next, fmt.Errorf("server paired device %s but saving configuration failed; generate a new re-pairing code for this device and retry: %w", next.DeviceID, err)
	}
	return config.Load(options.Path)
}

func prepare(options Options) (config.Config, map[string]json.RawMessage, error) {
	cfg := config.Config{Server: options.Server, DeviceID: options.DeviceID}
	var fields map[string]json.RawMessage
	var err error
	if options.Action == "re-pair" {
		cfg, fields, err = ReadRePair(options)
		if err != nil {
			return cfg, nil, err
		}
	}
	if _, err := config.ValidateServer(cfg.Server); err != nil {
		return cfg, nil, err
	}
	if strings.TrimSpace(options.Code) == "" {
		return cfg, nil, fmt.Errorf("pairing code is required")
	}
	if options.Action == "pair" {
		if _, err := os.Stat(options.Path); err == nil {
			return cfg, nil, fmt.Errorf("configuration already exists: %s; use re-pair", options.Path)
		} else if !os.IsNotExist(err) {
			return cfg, nil, err
		}
	}
	return cfg, fields, nil
}

func ReadRePair(options Options) (config.Config, map[string]json.RawMessage, error) {
	cfg, fields, err := config.ReadForRePair(options.Path)
	if os.IsNotExist(err) && options.Server != "" && options.DeviceID != "" {
		return config.Config{Server: options.Server, DeviceID: options.DeviceID}, nil, nil
	}
	if err != nil {
		return cfg, nil, err
	}
	if cfg.DeviceID == "" {
		return cfg, nil, fmt.Errorf("configuration has no device ID; supply --server and --device-id for a missing configuration")
	}
	if (options.Server != "" && options.Server != cfg.Server) || (options.DeviceID != "" && options.DeviceID != cfg.DeviceID) {
		return cfg, nil, fmt.Errorf("explicit server/device ID conflicts with existing configuration")
	}
	return cfg, fields, nil
}
