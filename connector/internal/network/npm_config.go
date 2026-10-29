package network

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

func NPMDeclaration(input Command) (Command, map[string]string, error) {
	p, err := Identify(input)
	if err != nil || p.Ecosystem != "npm" {
		return input, nil, nil
	}
	files, err := npmConfigPaths(input)
	if err != nil {
		return input, nil, err
	}
	values, err := readNpmConfig(files, input.Env)
	if err != nil {
		return input, nil, err
	}
	env := map[string]string{}
	if values["registry"] != "" {
		env["npm_config_registry"] = values["registry"]
	}
	for k, v := range input.Env {
		env[k] = v
	}
	input.Env = env
	if strings.HasPrefix(p.Name, "@") {
		input.ScopedSource = values[strings.SplitN(p.Name, "/", 2)[0]+":registry"]
	}
	source := firstValue([]string{input.ScopedSource, values["registry"], "https://registry.npmjs.org/"})
	input.SourceProtected = strings.HasPrefix(p.Name, "@") && NPMAuthorization(source, values) != ""
	return input, values, nil
}
func parseNPMRC(text string, values, env map[string]string) error {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		if key != "registry" && !strings.HasSuffix(key, ":registry") && !strings.HasPrefix(key, "//") {
			continue
		}
		value := strings.Trim(strings.TrimSpace(parts[1]), "\"'")
		value, err := npmVariables(value, env)
		if err != nil {
			return err
		}
		values[key] = value
	}
	return nil
}
func NPMAuthorization(source string, values map[string]string) string {
	u, err := url.Parse(source)
	if err != nil {
		return ""
	}
	best := ""
	auth := ""
	for key, value := range values {
		suffix := ":_authToken"
		if strings.HasSuffix(key, ":_auth") {
			suffix = ":_auth"
		}
		if !strings.HasSuffix(key, suffix) {
			continue
		}
		prefix := strings.TrimSuffix(key, suffix)
		if !npmScopeMatches(prefix, u) || len(prefix) <= len(best) {
			continue
		}
		best = prefix
		auth = "Bearer " + value
		if suffix == ":_auth" {
			auth = "Basic " + value
		}
	}
	if auth == "" {
		return npmBasicAuth(u, values)
	}
	return auth
}

func npmConfigPaths(input Command) ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	if input.Env["HOME"] != "" {
		home = input.Env["HOME"]
	}
	files := []string{}
	if path := input.Env["npm_config_globalconfig"]; path != "" {
		files = append(files, path)
	}
	user := input.Env["npm_config_userconfig"]
	if user == "" {
		user = input.Env["NPM_CONFIG_USERCONFIG"]
	}
	if user == "" {
		user = filepath.Join(home, ".npmrc")
	}
	files = append(files, user)
	project, err := projectNpmConfig(input.Cwd)
	if err != nil {
		return nil, err
	}
	if project != "" {
		files = append(files, project)
	}
	return files, nil
}

func readNpmConfig(files []string, env map[string]string) (map[string]string, error) {
	values := map[string]string{}
	for _, path := range files {
		data, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if err := parseNPMRC(string(data), values, env); err != nil {
			return nil, err
		}
	}
	return values, nil
}

func projectNpmConfig(directory string) (string, error) {
	cwd := directory
	if cwd == "" {
		var err error
		cwd, err = os.Getwd()
		if err != nil {
			return "", err
		}
	}
	for {
		path := filepath.Join(cwd, ".npmrc")
		_, err := os.Stat(path)
		if err == nil {
			return path, nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(cwd)
		if parent == cwd {
			break
		}
		cwd = parent
	}
	return "", nil
}

func npmVariables(value string, env map[string]string) (string, error) {
	variable := regexp.MustCompile(`\$\{([^}]+)\}`)
	var issue error
	value = variable.ReplaceAllStringFunc(value, func(match string) string {
		name := match[2 : len(match)-1]
		v, ok := env[name]
		if !ok {
			v, ok = os.LookupEnv(name)
		}
		if !ok {
			issue = fmt.Errorf("npm config references missing environment variable")
		}
		return v
	})
	return value, issue
}

func npmBasicAuth(u *url.URL, values map[string]string) string {
	auth := ""
	prefix := "//" + u.Host + strings.TrimSuffix(u.Path, "/") + "/:"
	if values[prefix+"username"] != "" {
		password, err := base64.StdEncoding.DecodeString(values[prefix+"_password"])
		if err == nil {
			auth = "Basic " + base64.StdEncoding.EncodeToString([]byte(values[prefix+"username"]+":"+string(password)))
		}
	}
	return auth
}

func firstValue(values []string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func npmScopeMatches(prefix string, source *url.URL) bool {
	scope, err := url.Parse("https:" + prefix)
	if err != nil || scope.Host != source.Host {
		return false
	}
	path := strings.TrimSuffix(scope.Path, "/")
	return source.Path == path || strings.HasPrefix(source.Path, path+"/")
}
