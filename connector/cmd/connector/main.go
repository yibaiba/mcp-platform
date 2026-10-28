package main

import (
	"context"
	"flag"
	"fmt"
	"github.com/kardianos/service"
	"log"
	"mcplatform/connector/internal/agent"
	"mcplatform/connector/internal/config"
	"mcplatform/connector/internal/files"
	"mcplatform/connector/internal/install"
	"mcplatform/connector/internal/mcpclient"
	"mcplatform/connector/internal/processtree"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	if err := execute(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
func execute() error {
	if len(os.Args) < 2 {
		return fmt.Errorf("usage: connector connect|pair|re-pair|run|install|uninstall --config path [--server URL] [--scope user|system]")
	}
	action := os.Args[1]
	flags := flag.NewFlagSet(action, flag.ContinueOnError)
	grace := flags.Duration("grace", 5*time.Second, "managed process shutdown grace period")
	path := flags.String("config", "connector.json", "configuration path")
	certificatePath := flags.String("ca-cert", "", "additional platform CA certificate PEM file")
	server := flags.String("server", "", "platform origin")
	deviceID := flags.String("device-id", "", "existing device ID when configuration is lost")
	scope := flags.String("scope", "user", "user for desktop apps; system for background services")
	if err := flags.Parse(os.Args[2:]); err != nil {
		return err
	}
	if action == "stdio-host" {
		return processtree.Host(flags.Args(), *grace)
	}
	client, err := newHTTPClient(*certificatePath)
	if err != nil {
		return err
	}
	if action == "re-pair" {
		return pairingCommand(client, repairOptions{Action: action, Path: *path, Server: *server, DeviceID: *deviceID})
	}
	if action == "pair" || action == "connect" {
		options := pairingOptions{Path: *path, Server: *server, Client: client, Input: os.Stdin, Output: os.Stderr}
		if err := prepareConnection(context.Background(), options, action == "connect"); err != nil {
			return err
		}
		if action == "pair" {
			return nil
		}
		action = "run"
	}
	program := &install.Program{Run: func(ctx context.Context) error { return run(ctx, *path, client) }}
	if action != "run" {
		return install.Control(program, *path, *scope, action)
	}
	if !service.Interactive() {
		svc, err := install.Configure(program, *path, *scope)
		if err != nil {
			return err
		}
		return svc.Run()
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return program.Run(ctx)
}
func run(ctx context.Context, path string, client *http.Client) error {
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
