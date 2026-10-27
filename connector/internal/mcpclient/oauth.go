package mcpclient

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// OAuthRequest is private device coordination, not a registered MCP tool.
func (m *Manager) OAuthRequest(ctx context.Context, raw json.RawMessage) (any, error) {
	var p struct {
		ConnectionID string            `json:"connectionId"`
		BindingID    string            `json:"bindingId"`
		Config       Config            `json:"config"`
		URL          string            `json:"url"`
		Method       string            `json:"method"`
		Headers      map[string]string `json:"headers"`
		Body         string            `json:"body"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	if p.ConnectionID == "" || p.BindingID == "" || p.Config.Transport == "stdio" {
		return nil, fmt.Errorf("OAuth request requires HTTP connection and binding")
	}
	if p.Method != "GET" && p.Method != "POST" {
		return nil, fmt.Errorf("OAuth channel accepts GET/POST only")
	}
	target, err := url.Parse(p.URL)
	if err != nil || target.Host == "" || target.User != nil || (target.Scheme != "http" && target.Scheme != "https") {
		return nil, fmt.Errorf("invalid OAuth URL")
	}
	request, err := http.NewRequestWithContext(ctx, p.Method, p.URL, strings.NewReader(p.Body))
	if err != nil {
		return nil, err
	}
	for name, value := range p.Headers {
		switch strings.ToLower(name) {
		case "accept", "content-type", "authorization", "mcp-protocol-version":
			request.Header.Set(name, value)
		default:
			return nil, fmt.Errorf("header is not part of the OAuth coordination channel: %s", name)
		}
	}
	client := &http.Client{Transport: m.transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}
	headers := map[string]string{}
	for _, name := range []string{"Content-Type", "WWW-Authenticate", "Location"} {
		if value := response.Header.Get(name); value != "" {
			headers[name] = value
		}
	}
	return map[string]any{"status": response.StatusCode, "headers": headers, "body": string(body)}, nil
}
