// Package connectorruntime composes the shared CLI and desktop connector services.
package connectorruntime

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"mcplatform/connector/internal/agent"
	"mcplatform/connector/internal/config"
	"mcplatform/connector/internal/files"
	"mcplatform/connector/internal/local"
	"mcplatform/connector/internal/local/sources"
	"mcplatform/connector/internal/local/storage"
	"mcplatform/connector/internal/mcpclient"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

type Options struct {
	DataDir      string
	Config       config.Config
	Client       *http.Client
	MCPTransport http.RoundTripper
	Locations    sources.Locations
	Diagnostics  io.Writer
	Changed      func(agent.ConnectionState)
	Error        func(error)
}

type Runtime struct {
	Local         *local.Service
	options       Options
	ctx           context.Context
	cancel        context.CancelFunc
	lease         *os.File
	remote, local *mcpclient.Manager
	operations    sync.Mutex
	stop          context.CancelFunc
	done          chan struct{}
	watchers      sync.WaitGroup
	closed        bool
}

func DataDir(home, override string, cfg config.Config) (string, error) {
	dir := filepath.Join(home, ".mcplatform", "local")
	if cfg.LocalDataDir != "" {
		dir = cfg.LocalDataDir
	}
	if override != "" {
		dir = override
	}
	if !filepath.IsAbs(dir) {
		return "", fmt.Errorf("local data directory must be absolute")
	}
	return dir, nil
}

func Open(parent context.Context, options Options) (*Runtime, error) {
	if options.Client == nil || options.MCPTransport == nil || options.Diagnostics == nil || options.Error == nil {
		return nil, fmt.Errorf("platform HTTP client, MCP transport, diagnostics and error callback are required")
	}
	if !filepath.IsAbs(options.DataDir) {
		return nil, fmt.Errorf("local data directory must be absolute")
	}
	store := storage.Store{Dir: options.DataDir}
	lease, err := store.Acquire()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	r := &Runtime{options: options, ctx: ctx, cancel: cancel, lease: lease}
	r.remote = mcpclient.New(ctx, options.Diagnostics, options.MCPTransport)
	r.local = mcpclient.New(ctx, options.Diagnostics, options.MCPTransport)
	target := ""
	if options.Config.DeviceID != "" {
		target = sources.ID(options.Config.Server, options.Config.DeviceID)
	}
	r.Local, err = local.New(ctx, local.Options{Store: store, SyncTarget: target,
		Locations: options.Locations, Runtime: r.local, Changed: r.remote.InvalidateResource, Error: options.Error})
	if err != nil {
		return nil, errors.Join(err, r.Close())
	}
	r.watchers.Add(1)
	go func() { defer r.watchers.Done(); r.Local.Watch(ctx) }()
	return r, nil
}

func (r *Runtime) Connect(cfg config.Config) error {
	r.operations.Lock()
	defer r.operations.Unlock()
	if r.closed {
		return fmt.Errorf("connector runtime is closed")
	}
	if r.stop != nil {
		return fmt.Errorf("platform connection is already running")
	}
	if err := r.Local.BindTarget(sources.ID(cfg.Server, cfg.DeviceID)); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(r.ctx)
	r.stop, r.done = cancel, make(chan struct{})
	handler := &agent.Dispatch{MCP: r.remote, Local: r.Local,
		Skills:    &files.SkillInstaller{Roots: cfg.SkillRoots},
		Artifacts: &files.ArtifactTransfer{Roots: cfg.ArtifactRoots, Client: r.options.Client, Server: cfg.Server}}
	runner := &agent.Runner{Config: cfg, Handler: handler, Client: r.options.Client,
		Logger: log.New(r.options.Diagnostics, "connector ", log.LstdFlags), Changed: r.options.Changed}
	go func() {
		defer close(r.done)
		if err := runner.Run(ctx); err != nil {
			r.options.Error(err)
		}
	}()
	return nil
}

func (r *Runtime) disconnect() error {
	if r.stop != nil {
		r.stop()
		<-r.done
		r.stop = nil
	}
	err := r.remote.CloseAll()
	if r.options.Changed != nil {
		r.options.Changed(agent.ConnectionState{Phase: "disconnected"})
	}
	return err
}

func (r *Runtime) Disconnect() error {
	r.operations.Lock()
	defer r.operations.Unlock()
	return r.disconnect()
}

func (r *Runtime) Close() error {
	r.operations.Lock()
	defer r.operations.Unlock()
	if r.closed {
		return nil
	}
	r.closed = true
	r.cancel()
	err := r.disconnect()
	r.watchers.Wait()
	if r.Local != nil {
		r.Local.Wait()
	}
	return errors.Join(err, r.local.CloseAll(), r.lease.Close())
}
