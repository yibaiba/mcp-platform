package main

import (
	"context"
	"log"
	"mcplatform/connector/internal/agent"
	"mcplatform/connector/internal/config"
	"mcplatform/connector/internal/connectorruntime"
	"mcplatform/connector/internal/files"
	"mcplatform/connector/internal/local/sources"
	"mcplatform/connector/internal/mcpclient"
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
	manager := mcpclient.New(ctx, os.Stderr, http.DefaultTransport)
	defer func() {
		if err := manager.CloseAll(); err != nil {
			log.Printf("MCP shutdown: %v", err)
		}
	}()
	handler := &agent.Dispatch{MCP: manager, Skills: &files.SkillInstaller{Roots: cfg.SkillRoots}, Artifacts: &files.ArtifactTransfer{Roots: cfg.ArtifactRoots, Client: client, Server: cfg.Server}}
	runner := agent.Runner{Config: cfg, Handler: handler, Client: client, Logger: log.New(os.Stderr, "connector ", log.LstdFlags)}
	return runner.Run(ctx)
}
