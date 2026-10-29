package main

import (
	"context"
	"fmt"
	"log"
	"mcplatform/connector/internal/config"
	"mcplatform/connector/internal/connectorruntime"
	"mcplatform/connector/internal/local/sources"
	"mcplatform/connector/internal/localhttp"
	"net/http"
	"os"
	"time"
)

type managementOptions struct {
	ConfigPath, DataDir string
	Client              *http.Client
	Offline             bool
}

func manage(ctx context.Context, options managementOptions) error {
	path, client, offline := options.ConfigPath, options.Client, options.Offline
	var cfg config.Config
	var err error
	if !offline {
		cfg, err = config.Load(path)
		if err != nil {
			return err
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dataDir, err := connectorruntime.DataDir(home, options.DataDir, cfg)
	if err != nil {
		return err
	}
	runtime, err := connectorruntime.Open(ctx, connectorruntime.Options{
		DataDir: dataDir, Config: cfg, Client: client, MCPTransport: http.DefaultTransport, Diagnostics: os.Stderr,
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
	localManager := runtime.Local
	server, err := localhttp.Start(localManager)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "本机管理（一次性链接）：%s\n", server.OpenURL())
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- server.Serve(); cancel() }()
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Close(closeCtx); err != nil {
			log.Printf("Local HTTP shutdown: %v", err)
		}
	}()
	if offline {
		select {
		case <-ctx.Done():
			return nil
		case err := <-done:
			return err
		}
	}
	if err := runtime.Connect(cfg); err != nil {
		return err
	}
	<-runCtx.Done()
	select {
	case err := <-done:
		return err
	default:
		return nil
	}
}
