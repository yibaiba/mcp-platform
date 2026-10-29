package main

import (
	"mcplatform/connector/internal/platformclient"
	"net/http"
)

func newHTTPClient(certificatePath string) (*http.Client, error) {
	return platformclient.New(certificatePath)
}
