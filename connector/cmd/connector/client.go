package main

import (
	"mcplatform/connector/internal/config"
	"mcplatform/connector/internal/connectorruntime"
	"mcplatform/connector/internal/network"
	"mcplatform/connector/internal/platformclient"
	"net/http"
	"os"
)

func newHTTPClient(certificatePath string) (*http.Client, error) {
	return platformclient.New(certificatePath)
}

func pairingHTTPClient(base *http.Client, paths runtimeOptions) (*http.Client, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	cfg := config.Config{}
	if _, err := os.Stat(paths.ConfigPath); err == nil {
		cfg, err = config.Load(paths.ConfigPath)
		if err != nil {
			return nil, err
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	directory, err := connectorruntime.DataDir(home, paths.DataDir, cfg)
	if err != nil {
		return nil, err
	}
	settings, err := network.Open(directory)
	if err != nil {
		return nil, err
	}
	client := *base
	transport := client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	client.Transport = &network.Transport{Store: settings, Base: transport}
	return &client, nil
}
