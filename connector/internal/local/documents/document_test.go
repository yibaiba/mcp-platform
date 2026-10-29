package documents

import (
	"strings"
	"testing"
)

func TestEditPreservesOtherEntriesAndComments(t *testing.T) {
	tests := []struct {
		name, format, input string
		path                []string
		value               map[string]any
		keep                []string
	}{
		{"jsonc", "jsonc", "{\n // unrelated\n \"theme\": true,\n \"mcpServers\":{\n // selected\n \"one\":{\"command\":\"node\", /* keep unknown */ \"custom\":true,\"args\":[\"before\"]},\n \"two\":{\"command\":\"untouched\"}\n }\n}", []string{"mcpServers", "one"}, map[string]any{"command": "node", "custom": true, "args": []any{"after"}}, []string{"// unrelated", "// selected", "/* keep unknown */", "\"two\":{\"command\":\"untouched\"}"}},
		{"toml", "toml", "# global\nmodel = \"m\"\n[mcp_servers.one]\ncommand = \"node\" # command comment\nargs = [\"before\"] # args comment\n# env comment\n[mcp_servers.one.env]\nTOKEN = \"${SECRET}\"\n[mcp_servers.two]\ncommand = \"untouched\"\n", []string{"mcp_servers", "one"}, map[string]any{"command": "node", "args": []any{"after"}, "env": map[string]any{"TOKEN": "${SECRET}"}}, []string{"# global", "# command comment", "# args comment", "# env comment", "TOKEN = \"${SECRET}\"", "[mcp_servers.two]\ncommand = \"untouched\""}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out, err := Edit([]byte(tt.input), tt.format, tt.path, tt.value)
			if err != nil {
				t.Fatal(err)
			}
			for _, keep := range tt.keep {
				if !strings.Contains(string(out), keep) {
					t.Fatalf("lost %q in %s", keep, out)
				}
			}
		})
	}
}
func TestTOMLNestedAddRemoveAndInline(t *testing.T) {
	input := []byte("other = 9\n[mcp_servers.\"a.b\"]\ncommand = 'node'\nenv = { TOKEN = 'secret', OTHER = 'keep' } # inline\n[mcp_servers.next]\ncommand = 'next'\n")
	next := map[string]any{"command": "node", "env": map[string]any{"TOKEN": "new", "OTHER": "keep"}, "args": []any{"--x"}}
	out, err := Edit(input, "toml", []string{"mcp_servers", "a.b"}, next)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "# inline") || !strings.Contains(string(out), "command = 'next'") {
		t.Fatalf("lost unrelated data: %s", out)
	}
	deleted, err := Edit(out, "toml", []string{"mcp_servers", "a.b"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := Insert(deleted, "toml", []string{"mcp_servers", "a.b"}, next)
	if err != nil {
		t.Fatal(err)
	}
	root, err := Parse(restored, "toml")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := At(root, []string{"mcp_servers", "a.b"}); !ok {
		t.Fatal("missing restored table")
	}
}
func TestMalformedConfigDoesNotExposeValues(t *testing.T) {
	for _, format := range []string{"json", "toml"} {
		_, err := Parse([]byte("TOP_SECRET = ["), format)
		if err == nil || strings.Contains(err.Error(), "TOP_SECRET") {
			t.Fatal("invalid or sensitive diagnostic", err)
		}
	}
}
