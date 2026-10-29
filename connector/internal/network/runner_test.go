package network

import (
	"reflect"
	"testing"
)

func TestNpmExecTrailingRegistry(t *testing.T) {
	for _, args := range [][]string{
		{"exec", "pkg@1.0.0", "--registry", "https://private.test/"},
		{"exec", "pkg@1.0.0", "--registry=https://private.test/"},
		{"exec", "pkg@1.0.0", "--registry=https://old.test/", "--registry=https://private.test/"},
		{"exec", "--package=pkg@1.0.0", "command", "--registry=https://private.test/"},
		{"exec", "pkg@1.0.0", "--registry=https://private.test/", "--", "tool-argument"},
	} {
		input := Command{Command: "npm", Args: args}
		config := Config{Settings: Settings{NPMRegistry: "https://mirror.test/"}}
		resolved, err := Resolve(input, config)
		if err != nil || resolved.Name != "pkg" || resolved.Source != "https://private.test/" {
			t.Fatalf("%v: %v %v", args, resolved, err)
		}
		input.PackageSource = "https://override.test/"
		prepared, err := Prepare(input, config)
		if err != nil {
			t.Fatal(err)
		}
		prepared.PackageSource = ""
		actual, err := Resolve(prepared, config)
		if err != nil || actual.Source != input.PackageSource {
			t.Fatalf("override not applied to execution: %v %v", actual, err)
		}
	}
}

func TestRunnerToolArgumentsAreNotRegistryOptions(t *testing.T) {
	for _, input := range []Command{
		{Command: "npm", Args: []string{"exec", "--", "pkg@1.0.0", "--registry", "https://tool.test/"}},
		{Command: "npm", Args: []string{"exec", "pkg@1.0.0", "--", "--registry", "https://tool.test/"}},
		{Command: "npx", Args: []string{"pkg@1.0.0", "--registry", "https://tool.test/"}},
	} {
		config := Config{Settings: Settings{NPMRegistry: "https://mirror.test/"}}
		resolved, err := Resolve(input, config)
		if err != nil || resolved.Name != "pkg" || resolved.Source != config.NPMRegistry {
			t.Fatalf("%v: %v %v", input.Args, resolved, err)
		}
		prepared, err := Prepare(input, config)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(prepared.Args[len(prepared.Args)-2:], []string{"--registry", "https://tool.test/"}) {
			t.Fatal("tool arguments changed", prepared.Args)
		}
	}
}

func TestNpmExecMultiplePackagesRemainAmbiguous(t *testing.T) {
	_, err := Identify(Command{Command: "npm", Args: []string{"exec", "--package=first", "command", "--package=second"}})
	if err == nil {
		t.Fatal("multiple packages accepted as one")
	}
}
