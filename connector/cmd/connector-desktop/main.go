package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"mcplatform/connector/internal/bundles"
	"mcplatform/connector/internal/desktop"
	"os"
	"path/filepath"
)

func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func run() (err error) {
	if len(os.Args) > 1 && os.Args[1] == "bundle-stdio" {
		return bundles.Stdio(os.Args[2:])
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	directory := filepath.Join(home, ".mcplatform")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	diagnostics, err := os.OpenFile(filepath.Join(directory, "connector-desktop.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer diagnostics.Close()
	previousLog := log.Writer()
	log.SetOutput(diagnostics)
	defer func() {
		if err != nil {
			log.Print(err)
		}
		log.SetOutput(previousLog)
	}()
	preferences, err := desktop.LoadPreferences(home)
	if err != nil {
		return err
	}
	flag.StringVar(&preferences.ConfigPath, "config", preferences.ConfigPath, "absolute connector configuration path")
	flag.StringVar(&preferences.DataDir, "data-dir", preferences.DataDir, "absolute local management data directory")
	flag.StringVar(&preferences.CAPath, "ca-cert", preferences.CAPath, "private platform CA PEM path")
	flag.Parse()
	if flag.NArg() != 0 {
		return fmt.Errorf("unexpected arguments")
	}
	if err := preferences.Validate(); err != nil {
		return err
	}
	return desktop.New(home, preferences, io.MultiWriter(diagnostics, os.Stderr)).Run()
}
