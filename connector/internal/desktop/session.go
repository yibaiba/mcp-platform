package desktop

import (
	"context"
	"fmt"
	"io"
	"mcplatform/connector/internal/agent"
	"mcplatform/connector/internal/config"
	"mcplatform/connector/internal/connectorruntime"
	"mcplatform/connector/internal/local/sources"
	"mcplatform/connector/internal/platformclient"
	"net/http"
	"os"
)

// Session is owned by the desktop worker. UI state is delivered separately on main.
type Session struct {
	Runtime     *connectorruntime.Runtime
	Config      config.Config
	Client      *http.Client
	Preferences Preferences
}

type SessionOptions struct {
	Home        string
	Preferences Preferences
	Diagnostics io.Writer
	Changed     func(agent.ConnectionState)
	Error       func(error)
}

func OpenSession(ctx context.Context, options SessionOptions) (*Session, error) {
	p := options.Preferences
	if err := p.Validate(); err != nil {
		return nil, err
	}
	client, err := platformclient.New(p.CAPath)
	if err != nil {
		return nil, err
	}
	cfg, err := config.Load(p.ConfigPath)
	if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("load connector configuration: %w", err)
	}
	dir, err := connectorruntime.DataDir(options.Home, p.DataDir, cfg)
	if err != nil {
		return nil, err
	}
	runtime, err := connectorruntime.Open(ctx, connectorruntime.Options{DataDir: dir, Config: cfg,
		Client: client, MCPTransport: http.DefaultTransport, Diagnostics: options.Diagnostics, Changed: options.Changed, Error: options.Error,
		Locations: sources.Locations{Home: options.Home, CodexHome: os.Getenv("CODEX_HOME"), PiHome: os.Getenv("PI_CODING_AGENT_DIR"), ConfigHome: os.Getenv("XDG_CONFIG_HOME")}})
	if err != nil {
		return nil, err
	}
	return &Session{Runtime: runtime, Config: cfg, Client: client, Preferences: p}, nil
}
