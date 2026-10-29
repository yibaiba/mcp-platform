package mcpclient

import (
	"bytes"
	"fmt"
	"io"
	"net/url"
	"sort"
	"strings"
	"sync"
)

// Local resource credentials stay on the device, including subprocess diagnostics.
// Buffer complete lines so credentials split across Write calls are redacted together.
type diagnosticWriter struct {
	mu      sync.Mutex
	output  io.Writer
	secrets []string
	pending []byte
}

func credentialStrings(c Config) []string {
	values := append([]string{c.URL}, c.Args...)
	for _, fields := range []map[string]string{c.Env, c.Headers} {
		for _, value := range fields {
			values = append(values, value)
		}
	}
	if parsed, err := url.Parse(c.URL); err == nil {
		for _, items := range parsed.Query() {
			values = append(values, items...)
		}
	}
	for _, arg := range c.Args {
		if _, value, ok := strings.Cut(arg, "="); ok {
			values = append(values, value)
		}
	}
	for key, value := range c.Headers {
		if strings.EqualFold(key, "authorization") {
			if _, token, ok := strings.Cut(value, " "); ok {
				values = append(values, token)
			}
		}
	}
	result := []string{}
	for _, value := range values {
		for _, line := range strings.Split(value, "\n") {
			if line != "" {
				result = append(result, line)
			}
		}
	}
	sort.Slice(result, func(i, j int) bool { return len(result[i]) > len(result[j]) })
	return result
}
func sanitize(text string, secrets []string) string {
	for _, secret := range secrets {
		text = strings.ReplaceAll(text, secret, "[redacted]")
	}
	return text
}
func (w *diagnosticWriter) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.pending = append(w.pending, data...)
	for {
		end := bytes.IndexByte(w.pending, '\n')
		if end < 0 {
			break
		}
		if _, err := io.WriteString(w.output, sanitize(string(w.pending[:end+1]), w.secrets)); err != nil {
			return 0, err
		}
		w.pending = w.pending[end+1:]
	}
	return len(data), nil
}
func (w *diagnosticWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.pending) == 0 {
		return nil
	}
	_, err := io.WriteString(w.output, sanitize(string(w.pending), w.secrets))
	w.pending = nil
	return err
}
func diagnosticError(err error, c Config) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s", sanitize(err.Error(), credentialStrings(c)))
}
