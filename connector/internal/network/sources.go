package network

import (
	"fmt"
	"net/url"
	"strings"
)

type Command struct {
	SourceProtected bool              `json:"-"`
	SourceUncertain string            `json:"-"`
	Cwd             string            `json:"cwd"`
	ScopedSource    string            `json:"-"`
	Command         string            `json:"command"`
	Args            []string          `json:"args"`
	Env             map[string]string `json:"env"`
	PackageSource   string            `json:"packageSource"`
}
type Package struct {
	Ecosystem  string `json:"ecosystem"`
	Name       string `json:"name"`
	Configured string `json:"configured"`
	Source     string `json:"source"`
}

func Resolve(input Command, c Config) (*Package, error) {
	if input.SourceUncertain != "" {
		return nil, fmt.Errorf("%s", input.SourceUncertain)
	}
	p, err := Identify(input)
	if err != nil {
		return nil, err
	}
	source, err := packageSource(input, p.Ecosystem, c)
	if err != nil {
		return nil, err
	}
	u, err := url.Parse(source)
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
	proxyEnv, err := proxyEnvironment(c)
	if err != nil {
		return result, err
	}
	for key, value := range proxyEnv {
		result.Env[key] = value
	}
	if _, err := Identify(input); err != nil || input.SourceUncertain != "" {
		return result, nil
	}
	p, err := Resolve(input, c)
	if err != nil {
		return result, err
	}
	result.Args = packageArguments(input, p)
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

func proxyEnvironment(c Config) (map[string]string, error) {
	env := map[string]string{}
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
			return nil, err
		}
		if p.auth != "" {
			pair := strings.SplitN(p.auth, ":", 2)
			password := ""
			if len(pair) == 2 {
				password = pair[1]
			}
			u.User = url.UserPassword(pair[0], password)
		}
		env[p.key] = u.String()
		env[strings.ToLower(p.key)] = u.String()
	}
	if c.NoProxy != "" {
		env["NO_PROXY"] = c.NoProxy
		env["no_proxy"] = c.NoProxy
	}
	return env, nil
}

func hasScopedSource(input Command) bool {
	index, prefix, _ := sourceArg(input)
	if strings.Contains(prefix, ":registry=") {
		return true
	}
	return index > 0 && strings.HasSuffix(input.Args[index-1], ":registry")
}

func packageSource(input Command, ecosystem string, c Config) (string, error) {
	keys, source, mirror := sourceDefaults(ecosystem, c)
	declared := declaredSource(input, keys)
	if declared != "" {
		source = declared
	}
	u, err := url.Parse(source)
	if err != nil {
		return "", fmt.Errorf("invalid package source")
	}
	if canMirror(input, u, mirror) && (declared == "" || (c.ReplacePublicSources && officialSource(u, ecosystem))) {
		source = mirror
	}
	if input.PackageSource != "" {
		source = input.PackageSource
	}
	return source, nil
}
func sourceDefaults(ecosystem string, c Config) ([]string, string, string) {
	if ecosystem == "pypi" {
		return []string{"UV_DEFAULT_INDEX", "UV_INDEX_URL", "PIP_INDEX_URL"}, "https://pypi.org/simple/", c.PythonIndex
	}
	return []string{"npm_config_registry", "NPM_CONFIG_REGISTRY"}, "https://registry.npmjs.org/", c.NPMRegistry
}
func declaredSource(input Command, keys []string) string {
	_, _, declared := sourceArg(input)
	if input.ScopedSource != "" && !hasScopedSource(input) {
		return input.ScopedSource
	}
	if declared != "" {
		return declared
	}
	for _, key := range keys {
		if input.Env[key] != "" {
			return input.Env[key]
		}
	}
	return ""
}
func canMirror(input Command, u *url.URL, mirror string) bool {
	return mirror != "" && !input.SourceProtected && u.User == nil
}
func officialSource(u *url.URL, ecosystem string) bool {
	if ecosystem == "pypi" {
		return u.Hostname() == "pypi.org" || u.Hostname() == "pypi.python.org"
	}
	return u.Hostname() == "registry.npmjs.org"
}

func packageArguments(input Command, p *Package) []string {
	args := append([]string{}, input.Args...)
	index, prefix, _ := sourceArg(input)
	if index >= 0 {
		args[index] = prefix + p.Source
	} else {
		_, offset := runner(input)
		flag := "--registry"
		if p.Ecosystem == "pypi" {
			flag = "--index-url"
		}
		args = append(append(append([]string{}, input.Args[:offset]...), flag, p.Source), input.Args[offset:]...)
	}
	if p.Ecosystem == "npm" && strings.HasPrefix(p.Name, "@") && (input.PackageSource != "" || input.ScopedSource != "") && !hasScopedSource(input) {
		_, offset := runner(input)
		flag := "--" + strings.SplitN(p.Name, "/", 2)[0] + ":registry=" + p.Source
		args = append(append(append([]string{}, args[:offset]...), flag), args[offset:]...)
	}
	return args
}
