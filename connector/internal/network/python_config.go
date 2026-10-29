package network

import (
	"fmt"
	"github.com/pelletier/go-toml/v2"
	"os"
	"path/filepath"
)

func PythonDeclaration(input Command) (Command, error) {
	p, err := Identify(input)
	if err != nil || p.Ecosystem != "pypi" {
		return input, nil
	}
	for _, arg := range input.Args {
		if arg == "--no-config" {
			return input, nil
		}
	}
	paths, err := pythonConfigPaths(input.Env)
	if err != nil {
		return input, err
	}
	declared, multiple, err := readPythonConfig(paths, input.Env)
	if err != nil {
		return input, err
	}
	env := map[string]string{}
	if declared != "" {
		env["UV_DEFAULT_INDEX"] = declared
	}
	for k, v := range input.Env {
		env[k] = v
	}
	input.Env = env
	if multiple {
		input.SourceUncertain = "多个 Python 索引，无法证明单一包来源"
	}
	return input, nil
}
func Declaration(input Command) (Command, map[string]string, error) {
	input, err := PythonDeclaration(input)
	if err != nil {
		return input, nil, err
	}
	return NPMDeclaration(input)
}

func pythonConfigPaths(env map[string]string) ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	if env["HOME"] != "" {
		home = env["HOME"]
	}
	system := env["PROGRAMDATA"]
	if system == "" {
		system = "/etc"
	}
	user := env["APPDATA"]
	if user == "" {
		user = env["XDG_CONFIG_HOME"]
	}
	if user == "" {
		user = filepath.Join(home, ".config")
	}
	paths := []string{filepath.Join(system, "uv", "uv.toml"), filepath.Join(user, "uv", "uv.toml")}
	if env["UV_CONFIG_FILE"] != "" {
		paths = []string{env["UV_CONFIG_FILE"]}
	}
	return paths, nil
}

type pythonConfig struct {
	IndexURL     string   `toml:"index-url"`
	DefaultIndex string   `toml:"default-index"`
	Extra        []string `toml:"extra-index-url"`
	Index        []struct {
		URL      string `toml:"url"`
		Default  bool   `toml:"default"`
		Explicit bool   `toml:"explicit"`
	} `toml:"index"`
}

func mergePythonConfig(config pythonConfig, declared string, multiple bool) (string, bool) {
	if config.IndexURL != "" {
		declared = config.IndexURL
	}
	if config.DefaultIndex != "" {
		declared = config.DefaultIndex
	}
	if len(config.Extra) > 0 {
		multiple = true
	}
	for _, index := range config.Index {
		if index.Default {
			declared = index.URL
		} else if !index.Explicit {
			multiple = true
		}
	}
	return declared, multiple
}

func readPythonConfig(paths []string, env map[string]string) (string, bool, error) {
	declared := ""
	multiple := env["UV_INDEX"] != "" || env["UV_EXTRA_INDEX_URL"] != ""
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return "", false, err
		}
		var config pythonConfig
		if err = toml.Unmarshal(data, &config); err != nil {
			return "", false, fmt.Errorf("invalid Python configuration")
		}
		declared, multiple = mergePythonConfig(config, declared, multiple)
	}
	return declared, multiple, nil
}
