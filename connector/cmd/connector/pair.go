package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/config"
	"mcplatform/connector/internal/pairing"
	"net/http"
	"os"
	"time"
)

type repairOptions struct{ Action, Path, Server, DeviceID string }

func pairingCommand(client *http.Client, options repairOptions) error {
	cfg := config.Config{Server: options.Server}
	if options.Action == "re-pair" {
		var err error
		cfg, _, err = rePairConfig(options)
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
	_, err = pairing.Save(ctx, client, pairing.Options{Action: options.Action, Path: options.Path,
		Server: options.Server, DeviceID: options.DeviceID, Code: line})
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Configuration saved. Restart the connector to use the new credential.")
	return nil
}

func rePairConfig(options repairOptions) (config.Config, map[string]json.RawMessage, error) {
	return pairing.ReadRePair(pairing.Options{Action: options.Action, Path: options.Path, Server: options.Server, DeviceID: options.DeviceID})
}
