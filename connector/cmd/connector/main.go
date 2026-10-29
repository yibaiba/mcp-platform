package main

import (
	"context"
	"flag"
	"fmt"
	"github.com/kardianos/service"
	"log"
	"mcplatform/connector/internal/bundles"
	"mcplatform/connector/internal/install"
	"mcplatform/connector/internal/processtree"
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
		return fmt.Errorf("usage: connector connect|pair|re-pair|run|manage|install|uninstall --config path [--server URL] [--scope user|system]")
	}
	action := os.Args[1]
	if action == "bundle-stdio" {
		return bundles.Stdio(os.Args[2:])
	}
	flags := flag.NewFlagSet(action, flag.ContinueOnError)
	grace := flags.Duration("grace", 5*time.Second, "managed process shutdown grace period")
	offline := flags.Bool("offline", true, "manage without a platform connection (use --offline=false with --config to sync)")
	dataDir := flags.String("data-dir", "", "absolute local management storage directory")
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
	if action == "manage" {
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		return manage(ctx, managementOptions{ConfigPath: *path, DataDir: *dataDir, Client: client, Offline: *offline})
	}
	pairingClient := client
	if action == "pair" || action == "connect" || action == "re-pair" {
		pairingClient, err = pairingHTTPClient(client, runtimeOptions{ConfigPath: *path, DataDir: *dataDir})
		if err != nil {
			return err
		}
		defer pairingClient.CloseIdleConnections()
	}
	if action == "re-pair" {
		return pairingCommand(pairingClient, repairOptions{Action: action, Path: *path, Server: *server, DeviceID: *deviceID})
	}
	if action == "pair" || action == "connect" {
		options := pairingOptions{Path: *path, Server: *server, Client: pairingClient, Input: os.Stdin, Output: os.Stderr}
		if err := prepareConnection(context.Background(), options, action == "connect"); err != nil {
			return err
		}
		if action == "pair" {
			return nil
		}
		action = "run"
	}
	program := &install.Program{Run: func(ctx context.Context) error {
		return runConnector(ctx, runtimeOptions{ConfigPath: *path, DataDir: *dataDir, Client: client})
	}}
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
