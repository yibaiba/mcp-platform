package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/agent"
	"mcplatform/connector/internal/config"
	"net/http"
	"os"
	"strings"
	"time"
)

type repairOptions struct{ Action, Path, Server, DeviceID string }

func pairingCommand(client *http.Client, options repairOptions) error {
	cfg := config.Config{Server: options.Server, DeviceID: options.DeviceID}
	var fields map[string]json.RawMessage
	if options.Action == "re-pair" {
		var err error
		cfg, fields, err = rePairConfig(options)
		if err != nil {
			return err
		}
	}
	if _, err := config.ValidateServer(cfg.Server); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Paste pairing code:")
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	var next config.Config
	if options.Action == "re-pair" {
		next, err = agent.RePair(ctx, client, agent.RePairInput{Config: cfg, Code: strings.TrimSpace(line)})
	} else {
		next, err = agent.Pair(ctx, client, cfg.Server, strings.TrimSpace(line))
	}
	if err != nil {
		return err
	}
	if options.Action == "re-pair" {
		err = config.ReplaceCredentials(options.Path, fields, next)
	} else {
		err = config.Save(options.Path, next)
	}
	if err != nil {
		return fmt.Errorf("server paired device %s but saving configuration failed; generate a new re-pairing code for this device and retry: %w", next.DeviceID, err)
	}
	fmt.Fprintln(os.Stderr, "Configuration saved. Restart the connector to use the new credential.")
	return nil
}

func rePairConfig(options repairOptions) (config.Config, map[string]json.RawMessage, error) {
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
