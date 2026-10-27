package main

import (
	"bufio"
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
	"strings"
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
		return fmt.Errorf("usage: connector pair|run|install|uninstall --config path [--server URL] [--scope user|system]")
	}
	action := os.Args[1]
	flags := flag.NewFlagSet(action, flag.ContinueOnError)
	grace := flags.Duration("grace", 5*time.Second, "managed process shutdown grace period")
	path := flags.String("config", "connector.json", "configuration path")
	server := flags.String("server", "", "platform origin")
	scope := flags.String("scope", "user", "user for desktop apps; system for background services")
	if err := flags.Parse(os.Args[2:]); err != nil {
		return err
	}
	if action == "stdio-host" {
		return processtree.Host(flags.Args(), *grace)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	if action == "pair" {
		fmt.Fprintln(os.Stderr, "Paste pairing code:")
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		c, err := agent.Pair(ctx, client, *server, strings.TrimSpace(line))
		if err != nil {
			return err
		}
		return config.Save(*path, c)
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
