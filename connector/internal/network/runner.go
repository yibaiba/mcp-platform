package network

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

type runnerDefinition struct {
	ecosystem string
	prefix    []string
}

var packageRunners = map[string]runnerDefinition{
	"npx": {"npm", nil}, "npm": {"npm", []string{"exec"}}, "uvx": {"pypi", nil}, "uv": {"pypi", []string{"tool", "run"}},
}
var packageFlags = map[string]bool{"--package": true, "-p": true, "--from": true}
var packageSwitches = map[string]bool{"-y": true, "--yes": true, "--no-install": true, "--no-cache": true, "--refresh": true, "--no-config": true}

type sourceOption struct {
	index         int
	prefix, value string
}
type runnerArguments struct {
	candidates []string
	positional string
	sources    map[string]sourceOption
}

func runner(input Command) (string, int) {
	cmd := strings.TrimSuffix(strings.TrimSuffix(filepath.Base(input.Command), ".exe"), ".cmd")
	definition, ok := packageRunners[cmd]
	if !ok || len(input.Args) < len(definition.prefix) {
		return "", 0
	}
	offset := len(definition.prefix)
	if strings.Join(input.Args[:offset], " ") != strings.Join(definition.prefix, " ") {
		return "", 0
	}
	return definition.ecosystem, offset
}
func isSourceFlag(flag string) bool {
	switch flag {
	case "--registry", "--index-url", "--default-index", "-i":
		return true
	}
	return regexp.MustCompile(`^--@[\w.-]+:registry$`).MatchString(flag)
}
func optionAt(args []string, index int) (string, sourceOption, error) {
	flag, value, inline := strings.Cut(args[index], "=")
	if inline {
		return flag, sourceOption{index, flag + "=", value}, nil
	}
	if index+1 >= len(args) {
		return "", sourceOption{}, fmt.Errorf("missing runner option value")
	}
	return flag, sourceOption{index + 1, "", args[index+1]}, nil
}
func parseArguments(args []string, offset int, interspersed bool) (runnerArguments, error) {
	result := runnerArguments{sources: map[string]sourceOption{}}
	for i := offset; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			if result.positional == "" {
				result.positional = nextArgument(args, i+1)
			}
			break
		}
		if !strings.HasPrefix(arg, "-") {
			if result.positional == "" {
				result.positional = arg
			}
			if !interspersed {
				break
			}
			continue
		}
		next, err := result.option(args, i)
		if err != nil {
			return result, err
		}
		i = next
	}
	return result, nil
}
func (r *runnerArguments) option(args []string, index int) (int, error) {
	flag, _, _ := strings.Cut(args[index], "=")
	if packageSwitches[args[index]] {
		return index, nil
	}
	if !packageFlags[flag] && !isSourceFlag(flag) {
		return index, fmt.Errorf("无法识别动态或复杂命令")
	}
	_, option, err := optionAt(args, index)
	if err != nil {
		return index, err
	}
	if packageFlags[flag] {
		r.candidates = append(r.candidates, option.value)
	} else {
		r.sources[flag] = option
	}
	return option.index, nil
}
func nextArgument(args []string, index int) string {
	if index >= len(args) {
		return ""
	}
	return args[index]
}
func declaredPackage(args runnerArguments) (string, error) {
	if len(args.candidates) > 1 {
		return "", fmt.Errorf("存在多个候选包")
	}
	if len(args.candidates) == 1 {
		return args.candidates[0], nil
	}
	return args.positional, nil
}
func Identify(input Command) (*Package, error) {
	ecosystem, offset := runner(input)
	if ecosystem == "" {
		return nil, fmt.Errorf("无法识别明确的 npm/Python 包声明")
	}
	args, err := parseArguments(input.Args, offset, ecosystem == "npm" && offset > 0)
	if err != nil {
		return nil, err
	}
	declared, err := declaredPackage(args)
	if err != nil {
		return nil, err
	}
	return parsePackage(declared, ecosystem)
}
func parsePackage(declared, ecosystem string) (*Package, error) {
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
	p, err := Identify(input)
	if err != nil {
		return -1, "", ""
	}
	_, offset := runner(input)
	args, err := parseArguments(input.Args, offset, p.Ecosystem == "npm" && offset > 0)
	if err != nil {
		return -1, "", ""
	}
	chosen := chooseSource(args.sources, p)
	return chosen.index, chosen.prefix, chosen.value
}
func chooseSource(sources map[string]sourceOption, p *Package) sourceOption {
	chosen := sourceOption{index: -1}
	if p.Ecosystem == "npm" {
		if general, ok := sources["--registry"]; ok {
			chosen = general
		}
		if scoped, ok := sources["--"+strings.SplitN(p.Name, "/", 2)[0]+":registry"]; ok {
			chosen = scoped
		}
		return chosen
	}
	for _, flag := range []string{"--index-url", "--default-index", "-i"} {
		if option, ok := sources[flag]; ok && option.index > chosen.index {
			chosen = option
		}
	}
	return chosen
}
