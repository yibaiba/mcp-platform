package platformclient

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net/http"
	"os"
)

// Additional private CAs are explicit and apply only to this connector process.
func New(certificatePath string) (*http.Client, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if certificatePath != "" {
		data, err := os.ReadFile(certificatePath)
		if err != nil {
			return nil, fmt.Errorf("read platform CA certificate: %w", err)
		}
		roots, err := x509.SystemCertPool()
		if err != nil {
			return nil, fmt.Errorf("load system CA certificates: %w", err)
		}
		if !roots.AppendCertsFromPEM(data) {
			return nil, fmt.Errorf("platform CA file contains no valid PEM certificate")
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: roots}
	}
	return &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, nil
}
