package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"mcplatform/connector/internal/agent"
	"mcplatform/connector/internal/config"
	"net/http"
	"os"
	"strings"
	"time"
)

const pairingRequestTimeout = 60 * time.Second

type pairingOptions struct {
	Path, Server string
	Client       *http.Client
	Input        io.Reader
	Output       io.Writer
}

func prepareConnection(ctx context.Context, options pairingOptions, reuse bool) error {
	_, err := os.Stat(options.Path)
	if err == nil {
		if !reuse {
			return fmt.Errorf("configuration already exists: %s", options.Path)
		}
		return reuseConnection(options)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if options.Server == "" {
		return fmt.Errorf("first connection requires --server URL and a pairing code from the platform Devices page")
	}
	if _, err := config.ValidateServer(options.Server); err != nil {
		return err
	}
	fmt.Fprintln(options.Output, "Paste pairing code from the platform Devices page:")
	code, err := readPairingCode(options.Input)
	if err != nil {
		return err
	}
	requestCtx, cancel := context.WithTimeout(ctx, pairingRequestTimeout)
	defer cancel()
	paired, err := agent.Pair(requestCtx, options.Client, options.Server, code)
	if err != nil {
		return err
	}
	if err := config.Save(options.Path, paired); err != nil {
		return fmt.Errorf("pairing completed but saving configuration failed (pairing code consumed): %w", err)
	}
	fmt.Fprintf(options.Output, "Device paired. Configuration saved to %s.\n", options.Path)
	return nil
}

func reuseConnection(options pairingOptions) error {
	paired, err := config.Load(options.Path)
	if err != nil {
		return fmt.Errorf("cannot reuse configuration: %w", err)
	}
	if options.Server != "" && strings.TrimRight(options.Server, "/") != strings.TrimRight(paired.Server, "/") {
		return fmt.Errorf("--server differs from the saved platform; use a separate --config path to pair another platform")
	}
	fmt.Fprintln(options.Output, "Using saved device configuration; no pairing code needed.")
	return nil
}

func readPairingCode(input io.Reader) (string, error) {
	line, err := bufio.NewReader(input).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	code := strings.TrimSpace(line)
	if code == "" {
		return "", fmt.Errorf("pairing code is empty; generate a code on the platform Devices page")
	}
	return code, nil
}
