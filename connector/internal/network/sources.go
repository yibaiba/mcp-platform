package network

import (
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
)

type Command struct {
	Command       string            `json:"command"`
	Args          []string          `json:"args"`
	Env           map[string]string `json:"env"`
	PackageSource string            `json:"packageSource"`
}
type Package struct {
	Ecosystem  string `json:"ecosystem"`
	Name       string `json:"name"`
	Configured string `json:"configured"`
	Source     string `json:"source"`
}

func runner(input Command) (string, int) {
	cmd := strings.TrimSuffix(strings.TrimSuffix(filepath.Base(input.Command), ".exe"), ".cmd")
	switch cmd {
	case "npx":
		return "npm", 0
	case "uvx":
		return "pypi", 0
	case "npm":
		if len(input.Args) > 0 && input.Args[0] == "exec" {
			return "npm", 1
		}
	case "uv":
		if len(input.Args) > 1 && input.Args[0] == "tool" && input.Args[1] == "run" {
			return "pypi", 2
		}
	}
	return "", 0
}
func Identify(input Command) (*Package, error) {
	ecosystem, offset := runner(input)
	if ecosystem == "" {
		return nil, fmt.Errorf("无法识别明确的 npm/Python 包声明")
	}
	candidates := []string{}
	positional := ""
	for i := offset; i < len(input.Args); i++ {
		arg := input.Args[i]
		if arg == "--" {
			if i+1 < len(input.Args) {
				positional = input.Args[i+1]
			}
			break
		}
		if arg == "--package" || arg == "-p" || arg == "--from" {
			i++
			if i >= len(input.Args) {
				return nil, fmt.Errorf("missing package")
			}
			candidates = append(candidates, input.Args[i])
			continue
		}
		if strings.HasPrefix(arg, "--package=") || strings.HasPrefix(arg, "--from=") {
			candidates = append(candidates, strings.SplitN(arg, "=", 2)[1])
			continue
		}
		if arg == "--registry" || arg == "--index-url" || arg == "--default-index" || arg == "-i" {
			i++
			continue
		}
		if strings.HasPrefix(arg, "--registry=") || strings.HasPrefix(arg, "--index-url=") || strings.HasPrefix(arg, "--default-index=") || arg == "-y" || arg == "--yes" || arg == "--no-install" || arg == "--no-cache" || arg == "--refresh" {
			continue
		}
		if strings.HasPrefix(arg, "-") {
			return nil, fmt.Errorf("无法识别动态或复杂命令")
		}
		positional = arg
		break
	}
	if len(candidates) > 1 {
		return nil, fmt.Errorf("存在多个候选包")
	}
	declared := positional
	if len(candidates) == 1 {
		declared = candidates[0]
	}
	pattern := `^((?:@[\w.-]+/)?[\w.-]+)(?:@([^\s/]+))?$`
	if ecosystem == "pypi" {
		pattern = `^([A-Za-z0-9][A-Za-z0-9._-]*)(?:(==|>=|~=|<=|>|<|!=)([\w.!+*,-]+))?$`
	}
	match := regexp.MustCompile(pattern).FindStringSubmatch(declared)
	if match == nil {
		return nil, fmt.Errorf("无法识别包声明")
	}
	configured := "latest"
	if ecosystem == "pypi" {
		configured = "*"
		if match[2] != "" {
			configured = match[2] + match[3]
		}
	} else if match[2] != "" {
		configured = match[2]
	}
	return &Package{Ecosystem: ecosystem, Name: match[1], Configured: configured}, nil
}
func sourceArg(input Command) (int, string, string) {
	ecosystem, offset := runner(input)
	flags := []string{"--registry"}
	if ecosystem == "pypi" {
		flags = []string{"--index-url", "--default-index", "-i"}
	}
	for i := offset; i < len(input.Args); i++ {
		arg := input.Args[i]
		if arg == "--" {
			break
		}
		for _, flag := range flags {
			if arg == flag && i+1 < len(input.Args) {
				return i + 1, "", input.Args[i+1]
			}
			if strings.HasPrefix(arg, flag+"=") {
				return i, flag + "=", strings.TrimPrefix(arg, flag+"=")
			}
		}
		if arg == "--package" || arg == "--from" || arg == "-p" {
			i++
			continue
		}
		if !strings.HasPrefix(arg, "-") {
			break
		}
	}
	return -1, "", ""
}
func Resolve(input Command, c Config) (*Package, error) {
	p, err := Identify(input)
	if err != nil {
		return nil, err
	}
	_, _, declared := sourceArg(input)
	keys := []string{"npm_config_registry", "NPM_CONFIG_REGISTRY"}
	source := "https://registry.npmjs.org/"
	mirror := c.NPMRegistry
	if p.Ecosystem == "pypi" {
		keys = []string{"UV_DEFAULT_INDEX", "UV_INDEX_URL", "PIP_INDEX_URL"}
		source = "https://pypi.org/simple/"
		mirror = c.PythonIndex
	}
	if declared == "" {
		for _, key := range keys {
			if input.Env[key] != "" {
				declared = input.Env[key]
				break
			}
		}
	}
	if declared != "" {
		source = declared
	}
	u, err := url.Parse(source)
	if err != nil {
		return nil, fmt.Errorf("invalid package source")
	}
	official := u.Hostname() == "registry.npmjs.org"
	if p.Ecosystem == "pypi" {
		official = u.Hostname() == "pypi.org" || u.Hostname() == "pypi.python.org"
	}
	if mirror != "" && (declared == "" || (c.ReplacePublicSources && official)) {
		source = mirror
	}
	if input.PackageSource != "" {
		source = input.PackageSource
	}
	u, err = url.Parse(source)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("invalid package source")
	}
	p.Source = u.String()
	return p, nil
}
func Prepare(input Command, c Config) (Command, error) {
	result := input
	result.Args = append([]string{}, input.Args...)
	result.Env = map[string]string{}
	for k, v := range input.Env {
		result.Env[k] = v
	}
	proxies := []struct{ key, raw, auth string }{{"HTTP_PROXY", c.HTTPProxy, c.Secrets["httpProxyAuth"]}, {"HTTPS_PROXY", c.HTTPSProxy, c.Secrets["httpsProxyAuth"]}}
	if proxies[1].raw == "" {
		proxies[1].raw = proxies[0].raw
		proxies[1].auth = proxies[0].auth
	}
	for _, p := range proxies {
		if p.raw == "" {
			continue
		}
		u, err := url.Parse(p.raw)
		if err != nil {
			return result, err
		}
		if p.auth != "" {
			pair := strings.SplitN(p.auth, ":", 2)
			password := ""
			if len(pair) == 2 {
				password = pair[1]
			}
			u.User = url.UserPassword(pair[0], password)
		}
		result.Env[p.key] = u.String()
		result.Env[strings.ToLower(p.key)] = u.String()
	}
	if c.NoProxy != "" {
		result.Env["NO_PROXY"] = c.NoProxy
		result.Env["no_proxy"] = c.NoProxy
	}
	if _, err := Identify(input); err != nil {
		return result, nil
	}
	p, err := Resolve(input, c)
	if err != nil {
		return result, err
	}
	index, prefix, _ := sourceArg(input)
	if index >= 0 {
		result.Args[index] = prefix + p.Source
	} else {
		_, offset := runner(input)
		flag := "--registry"
		if p.Ecosystem == "pypi" {
			flag = "--index-url"
		}
		result.Args = append(append(append([]string{}, input.Args[:offset]...), flag, p.Source), input.Args[offset:]...)
	}
	if p.Ecosystem == "npm" {
		result.Env["npm_config_registry"] = p.Source
		result.Env["NPM_CONFIG_REGISTRY"] = p.Source
	} else {
		result.Env["UV_DEFAULT_INDEX"] = p.Source
		result.Env["UV_INDEX_URL"] = p.Source
		result.Env["PIP_INDEX_URL"] = p.Source
	}
	return result, nil
}
