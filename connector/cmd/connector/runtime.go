package main

import (
	"context"
	"encoding/json"
	"log"
	"mcplatform/connector/internal/agent"
	"mcplatform/connector/internal/config"
	"mcplatform/connector/internal/connectorruntime"
	"mcplatform/connector/internal/files"
	"mcplatform/connector/internal/local/sources"
	"mcplatform/connector/internal/mcpclient"
	"mcplatform/connector/internal/network"
	"net/http"
	"os"
)

type runtimeOptions struct {
	ConfigPath, DataDir string
	Client              *http.Client
}

func runConnector(ctx context.Context, options runtimeOptions) error {
	path, client, dataDir := options.ConfigPath, options.Client, options.DataDir
	cfg, err := config.Load(path)
	if err != nil {
		return err
	}
	if dataDir == "" && cfg.LocalDataDir == "" {
		return runLegacy(ctx, path, client)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	directory, err := connectorruntime.DataDir(home, dataDir, cfg)
	if err != nil {
		return err
	}
	runtime, err := connectorruntime.Open(ctx, connectorruntime.Options{
		DataDir: directory, Config: cfg, Client: client, MCPTransport: http.DefaultTransport, Diagnostics: os.Stderr,
		Locations: sources.Locations{Home: home, CodexHome: os.Getenv("CODEX_HOME"), PiHome: os.Getenv("PI_CODING_AGENT_DIR"), ConfigHome: os.Getenv("XDG_CONFIG_HOME")},
		Error:     func(err error) { log.Printf("Local management: %v", err) },
	})
	if err != nil {
		return err
	}
	defer func() {
		if err := runtime.Close(); err != nil {
			log.Printf("Connector shutdown: %v", err)
		}
	}()
	if err := runtime.Connect(cfg); err != nil {
		return err
	}
	<-ctx.Done()
	return nil
}

func runLegacy(ctx context.Context, path string, client *http.Client) error {
	cfg, err := config.Load(path)
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	directory, err := connectorruntime.DataDir(home, "", cfg)
	if err != nil {
		return err
	}
	settings, err := network.Open(directory)
	if err != nil {
		return err
	}
	transport := &network.Transport{Store: settings, Base: http.DefaultTransport}
	defer transport.CloseIdleConnections()
	copied := *client
	if copied.Transport == nil {
		copied.Transport = http.DefaultTransport
	}
	copied.Transport = &network.Transport{Store: settings, Base: copied.Transport}
	client = &copied
	defer client.CloseIdleConnections()
	manager := mcpclient.New(ctx, os.Stderr, transport)
	manager.Prepare = func(c mcpclient.Config) (mcpclient.Config, error) {
		declaration, _, err := network.Declaration(network.Command{Command: c.Command, Args: c.Args, Env: c.Env, Cwd: c.Cwd, PackageSource: c.PackageSource})
		if err != nil {
			return c, err
		}
		config, _ := settings.Snapshot()
		prepared, err := network.Prepare(declaration, config)
		c.Args = prepared.Args
		c.Env = prepared.Env
		return c, err
	}
	defer func() {
		if err := manager.CloseAll(); err != nil {
			log.Printf("MCP shutdown: %v", err)
		}
	}()
	handler := &agent.Dispatch{PackagePreview: func(raw json.RawMessage) (any, error) {
		var input struct {
			Config network.Command `json:"config"`
		}
		if err := json.Unmarshal(raw, &input); err != nil {
			return nil, err
		}
		return network.PreviewPackage(input.Config, settings)
	}, PackageCheck: func(ctx context.Context, raw json.RawMessage) (any, error) {
		var input struct {
			Config network.Command `json:"config"`
		}
		if err := json.Unmarshal(raw, &input); err != nil {
			return nil, err
		}
		return network.CheckPackage(ctx, network.PackageCheckOptions{Input: input.Config, Store: settings, Client: client})
	}, MCP: manager, Skills: &files.SkillInstaller{Roots: cfg.SkillRoots}, Artifacts: &files.ArtifactTransfer{Roots: cfg.ArtifactRoots, Client: client, Server: cfg.Server}}
	runner := agent.Runner{Config: cfg, Handler: handler, Client: client, Logger: log.New(os.Stderr, "connector ", log.LstdFlags)}
	return runner.Run(ctx)
}
