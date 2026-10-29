package network

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
)

func Bypass(u *url.URL, value string) bool {
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	port := u.Port()
	if port == "" {
		port = "80"
		if u.Scheme == "https" {
			port = "443"
		}
	}
	for _, entry := range strings.FieldsFunc(strings.ToLower(value), func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == '\t' }) {
		if entry == "*" {
			return true
		}
		if matchesProxyEntry(host, port, entry) {
			return true
		}
	}
	return false
}
func proxy(c Config) func(*http.Request) (*url.URL, error) {
	return func(r *http.Request) (*url.URL, error) {
		raw, auth := c.HTTPProxy, c.Secrets["httpProxyAuth"]
		if r.URL.Scheme == "https" && c.HTTPSProxy != "" {
			raw, auth = c.HTTPSProxy, c.Secrets["httpsProxyAuth"]
		}
		if raw == "" || Bypass(r.URL, c.NoProxy) {
			return nil, nil
		}
		u, err := url.Parse(raw)
		if err != nil {
			return nil, err
		}
		if auth != "" {
			pair := strings.SplitN(auth, ":", 2)
			password := ""
			if len(pair) == 2 {
				password = pair[1]
			}
			u.User = url.UserPassword(pair[0], password)
		}
		return u, nil
	}
}

type Transport struct {
	Store     *Store
	Base      http.RoundTripper
	mu        sync.Mutex
	revision  int
	transport *http.Transport
}

func (t *Transport) current(c Config, revision int) (http.RoundTripper, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.transport == nil || revision != t.revision {
		if t.transport != nil {
			t.transport.CloseIdleConnections()
		}
		base, ok := t.Base.(*http.Transport)
		if !ok {
			if c.HTTPProxy != "" || c.HTTPSProxy != "" {
				return nil, fmt.Errorf("injected transport does not support proxy configuration")
			}
			return t.Base, nil
		}
		t.transport = base.Clone()
		t.transport.Proxy = proxy(c)
		t.revision = revision
	}
	return t.transport, nil
}
func (t *Transport) RoundTrip(r *http.Request) (*http.Response, error) {
	c, revision := t.Store.Snapshot()
	target, token, err := r.URL, "", error(nil)
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		target, token, err = Rewrite(r.URL, c)
	}
	if err != nil {
		return nil, err
	}
	request := r.Clone(r.Context())
	request.URL = target
	request.Host = ""
	if target.Host != r.URL.Host || target.Scheme != r.URL.Scheme {
		strip(request.Header)
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	transport, err := t.current(c, revision)
	if err != nil {
		return nil, err
	}
	response, err := transport.RoundTrip(request)
	if err != nil {
		return nil, fmt.Errorf("network request failed (check endpoint, proxy, credentials and certificates)")
	}
	response.Request = request
	if target.String() != r.URL.String() {
		if err := resolveRedirect(response); err != nil {
			response.Body.Close()
			return nil, err
		}
	}
	return response, nil
}
func (t *Transport) CloseIdleConnections() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.transport != nil {
		t.transport.CloseIdleConnections()
	}
}
func strip(headers http.Header) {
	for name := range headers {
		switch strings.ToLower(name) {
		case "accept", "accept-language", "content-type", "user-agent", "if-none-match", "if-modified-since", "range":
		default:
			headers.Del(name)
		}
	}
}
func Rewrite(u *url.URL, c Config) (*url.URL, string, error) {
	raw, token := u.String(), ""
	switch u.Hostname() {
	case "api.github.com":
		if c.GitHubAPI != "" {
			raw = strings.TrimSuffix(c.GitHubAPI, "/") + u.EscapedPath()
			if u.RawQuery != "" {
				raw += "?" + u.RawQuery
			}
			token = c.Secrets["githubApiToken"]
		}
	case "github.com", "raw.githubusercontent.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com":
		if c.GitHubDownload != "" && isDownloadURL(u) {
			raw = strings.ReplaceAll(strings.ReplaceAll(c.GitHubDownload, "{url}", u.String()), "{encodedUrl}", url.QueryEscape(u.String()))
			token = c.Secrets["githubDownloadToken"]
		}
	}
	target, err := url.Parse(raw)
	if err != nil {
		return nil, "", err
	}
	if err = validateRewrite(u, target); err != nil {
		return nil, "", err
	}
	return target, token, err
}

func matchesProxyEntry(host, port, entry string) bool {
	pattern, p, err := net.SplitHostPort(entry)
	if err != nil {
		pattern = entry
	} else if port != p {
		return false
	}
	pattern = strings.Trim(pattern, "[]")
	pattern = strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(pattern, "*"), "."), ".")
	if address := net.ParseIP(pattern); address != nil {
		if address.Equal(net.ParseIP(host)) {
			return true
		}
		return false
	}
	if host == pattern || (!strings.Contains(pattern, ":") && strings.HasSuffix(host, "."+pattern)) {
		return true
	}
	return false
}

func validateRewrite(u, target *url.URL) error {
	if target.Host != u.Host || target.Scheme != u.Scheme {
		sensitive := u.User != nil
		for name := range u.Query() {
			if regexp.MustCompile(`(?i)(token|auth|secret|credential|signature|api.?key|^sig$)`).MatchString(name) {
				sensitive = true
			}
		}
		if sensitive {
			return fmt.Errorf("GitHub URL contains authentication parameters; cannot forward to accelerator")
		}
	}
	return nil
}

func isDownloadURL(u *url.URL) bool {
	if u.Hostname() != "github.com" {
		return true
	}
	return regexp.MustCompile(`^/[^/]+/[^/]+/(?:archive/|raw/|releases/(?:download|latest/download)/)`).MatchString(u.Path)
}
