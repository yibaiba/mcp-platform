package sources

import (
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/local/documents"
	"mcplatform/connector/internal/local/model"
	"mcplatform/connector/internal/mcpclient"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

var variable = regexp.MustCompile(`\$\{([^}]+)\}`)

func expand(text string, source model.Source) (string, error) {
	if source.Client == "codex" {
		return text, nil
	}
	var issue error
	result := variable.ReplaceAllStringFunc(text, func(match string) string {
		key := match[2 : len(match)-1]
		home, _ := os.UserHomeDir()
		if source.Client == "cursor" {
			switch key {
			case "userHome":
				return home
			case "workspaceFolder":
				if source.Project != "" {
					return source.Project
				}
			case "workspaceFolderBasename":
				if source.Project != "" {
					return filepath.Base(source.Project)
				}
			case "pathSeparator", "/":
				return string(filepath.Separator)
			}
			if !strings.HasPrefix(key, "env:") {
				issue = fmt.Errorf("unsupported or unavailable Cursor variable: %s", key)
				return match
			}
			key = strings.TrimPrefix(key, "env:")
		}
		fallback := ""
		hasFallback := false
		if source.Client == "claude" {
			if index := strings.Index(key, ":-"); index >= 0 {
				fallback = key[index+2:]
				key = key[:index]
				hasFallback = true
			}
		}
		if !regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`).MatchString(key) {
			issue = fmt.Errorf("unsupported variable expression")
			return match
		}
		if value, ok := os.LookupEnv(key); ok {
			return value
		}
		if hasFallback {
			return fallback
		}
		issue = fmt.Errorf("missing environment variable: %s", key)
		return match
	})
	return result, issue
}
func Inspect(entry map[string]any, source model.Source) []string {
	_, err := Runtime(entry, source)
	if err != nil {
		return []string{err.Error()}
	}
	return []string{}
}
func Runtime(entry map[string]any, source model.Source) (mcpclient.Config, error) {
	var config mcpclient.Config
	if err := validateFieldTypes(entry); err != nil {
		return config, err
	}
	if entry["enabled"] == false || entry["disabled"] == true {
		return config, fmt.Errorf("disabled in client configuration")
	}
	for key := range entry {
		switch key {
		case "command", "args", "env", "cwd", "url", "headers", "http_headers", "env_http_headers", "env_vars", "bearer_token_env_var", "type", "transport", "description", "enabled", "disabled", "name":
		default:
			return config, fmt.Errorf("client field %s requires local handling; connector execution does not implement its semantics", key)
		}
	}
	copy := map[string]any{}
	for key, value := range entry {
		copy[key] = value
	}
	if source.Client == "codex" {
		copy["headers"] = entry["http_headers"]
	}
	data := documents.Encode(copy)
	if err := json.Unmarshal(data, &config); err != nil {
		return config, fmt.Errorf("invalid MCP field types")
	}
	if config.Command != "" && config.URL != "" {
		return config, fmt.Errorf("MCP entry must choose command or URL")
	}
	kind, _ := entry["type"].(string)
	if kind == "" {
		kind, _ = entry["transport"].(string)
	}
	if config.URL != "" {
		if source.Client == "claude" && kind == "" {
			return config, fmt.Errorf("Claude HTTP entry requires type")
		}
		config.Transport = "http"
		config.Mode = "existing"
		if kind == "sse" {
			config.Transport = "sse"
		} else if kind != "" && kind != "http" && kind != "streamable-http" {
			return config, fmt.Errorf("unsupported HTTP transport: %s", kind)
		}
	} else {
		if kind != "" && kind != "stdio" {
			return config, fmt.Errorf("transport %s requires local handling or a URL", kind)
		}
		config.Transport = "stdio"
		config.Mode = "managed"
		if config.Command == "" {
			return config, fmt.Errorf("MCP command or URL is required")
		}
	}
	if config.Cwd == "" && config.Transport == "stdio" {
		config.Cwd = source.Project
	}
	if err := resolve(&config, source); err != nil {
		return config, err
	}
	if source.Client == "codex" {
		if err := codexEnvironment(&config, entry); err != nil {
			return config, err
		}
	}
	if config.URL != "" {
		u, err := url.Parse(config.URL)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
			return config, fmt.Errorf("MCP URL must be HTTP(S) without user information")
		}
	}
	return config, nil
}
func resolve(config *mcpclient.Config, source model.Source) error {
	var err error
	for _, field := range []*string{&config.Command, &config.Cwd, &config.URL} {
		*field, err = expand(*field, source)
		if err != nil {
			return err
		}
	}
	for i, value := range config.Args {
		config.Args[i], err = expand(value, source)
		if err != nil {
			return err
		}
	}
	for _, values := range []map[string]string{config.Env, config.Headers} {
		for key, value := range values {
			if source.Client == "pi" && strings.HasPrefix(value, "!") {
				return fmt.Errorf("dynamic credential expressions require local handling")
			}
			values[key], err = expand(value, source)
			if err != nil {
				return err
			}
		}
	}
	if source.Client == "pi" {
		home, _ := os.UserHomeDir()
		for _, field := range []*string{&config.Command, &config.Cwd} {
			if strings.HasPrefix(*field, "~/") {
				*field = filepath.Join(home, (*field)[2:])
			}
		}
		for i, arg := range config.Args {
			if strings.HasPrefix(arg, "~/") {
				config.Args[i] = filepath.Join(home, arg[2:])
			}
		}
	}
	return nil
}
func codexEnvironment(config *mcpclient.Config, entry map[string]any) error {
	if config.Env == nil {
		config.Env = map[string]string{}
	}
	if config.Headers == nil {
		config.Headers = map[string]string{}
	}
	read := func(name string) (string, error) {
		value, ok := os.LookupEnv(name)
		if !ok {
			return "", fmt.Errorf("missing environment variable: %s", name)
		}
		return value, nil
	}
	if raw, exists := entry["env_vars"]; exists {
		values, ok := raw.([]any)
		if !ok {
			return fmt.Errorf("Codex env_vars must be a list of environment variable names")
		}
		for _, item := range values {
			name, ok := item.(string)
			if !ok {
				return fmt.Errorf("remote environment references require local handling")
			}
			value, err := read(name)
			if err != nil {
				return err
			}
			config.Env[name] = value
		}
	}
	if values, ok := entry["env_http_headers"].(map[string]any); ok {
		for key, item := range values {
			name, ok := item.(string)
			if !ok {
				return fmt.Errorf("invalid header environment reference")
			}
			value, err := read(name)
			if err != nil {
				return err
			}
			config.Headers[key] = value
		}
	}
	if name, ok := entry["bearer_token_env_var"].(string); ok {
		value, err := read(name)
		if err != nil {
			return err
		}
		config.Headers["Authorization"] = "Bearer " + value
	}
	return nil
}
func programExists(entry map[string]any, source model.Source) bool {
	config, err := Runtime(entry, source)
	if err != nil || config.Command == "" {
		return false
	}
	command := config.Command
	if config.Cwd != "" && !filepath.IsAbs(command) && strings.ContainsAny(command, `/\`) {
		command = filepath.Join(config.Cwd, command)
	}
	_, err = exec.LookPath(command)
	return err == nil
}

func validateFieldTypes(entry map[string]any) error {
	for _, key := range []string{"type", "transport", "description", "name", "bearer_token_env_var"} {
		if value, exists := entry[key]; exists {
			if _, ok := value.(string); !ok {
				return fmt.Errorf("MCP field %s must be a string", key)
			}
		}
	}
	for _, key := range []string{"enabled", "disabled"} {
		if value, exists := entry[key]; exists {
			if _, ok := value.(bool); !ok {
				return fmt.Errorf("MCP field %s must be a boolean", key)
			}
		}
	}
	if value, exists := entry["env_http_headers"]; exists {
		if _, ok := value.(map[string]any); !ok {
			return fmt.Errorf("env_http_headers must map header names to environment variable names")
		}
	}
	return nil
}
