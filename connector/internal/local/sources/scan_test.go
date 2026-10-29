package sources

import (
	"context"
	"mcplatform/connector/internal/local/documents"
	"mcplatform/connector/internal/local/model"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
}
func TestFourClientSourcesAndDedup(t *testing.T) {
	home := t.TempDir()
	project := filepath.Join(home, "project")
	if err := os.MkdirAll(project, 0700); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(home, ".cursor", "mcp.json"), `{"mcpServers":{"same":{"command":"echo","args":["${env:SCAN_MISSING}"]}}}`)
	write(t, filepath.Join(home, ".claude.json"), `{"mcpServers":{"same":{"command":"echo"}},"projects":{`+`"`+filepath.ToSlash(project)+`"`+`:{"mcpServers":{"private":{"command":"echo"}}}}}`)
	write(t, filepath.Join(home, ".codex", "config.toml"), "[mcp_servers.same]\ncommand='echo'\n")
	write(t, filepath.Join(project, ".mcp.json"), `{"mcpServers":{"shared":{"type":"http","url":"http://localhost:1/mcp"}}}`)
	write(t, filepath.Join(home, ".pi", "agent", "mcp-adapter.json"), `{"mcpServers":{"pi":{"command":"echo"}},"settings":{"keep":true}}`)
	write(t, filepath.Join(home, ".agents", "skills", "example", "SKILL.md"), "---\nname: example\ndescription: A skill\n---\nNever execute scans.\n")
	list := User(Locations{Home: home})
	projects, err := Project(home, project)
	if err != nil {
		t.Fatal(err)
	}
	list = append(list, projects...)
	resources, issues := Scan(context.Background(), list)
	if len(issues) > 0 {
		t.Fatal(issues)
	}
	names := map[string]int{}
	for _, r := range resources {
		names[r.Name]++
		if r.Name == "shared" && len(r.Clients) != 2 {
			t.Fatal("real file was not deduplicated", r)
		}
		if r.Name == "example" && len(r.Clients) != 4 {
			t.Fatal("shared skill ownership lost", r)
		}
		if r.Clients[0] == "cursor" && r.Name == "same" && !strings.Contains(strings.Join(r.Issues, " "), "SCAN_MISSING") {
			t.Fatal("missing environment diagnostic")
		}
	}
	if names["same"] != 3 || names["private"] != 1 || names["pi"] != 1 || names["example"] != 1 {
		t.Fatal(names)
	}
}
func TestCorruptionIsReported(t *testing.T) {
	home := t.TempDir()
	source := New("cursor", "mcp", filepath.Join(home, "mcp.json"), "")
	write(t, source.Path, "{ secret: invalid")
	resources, issues := Scan(context.Background(), []model.Source{source})
	if len(resources) != 0 || len(issues) != 1 || strings.Contains(issues[0], "secret") {
		t.Fatal(resources, issues)
	}
}
func TestClientEditsKeepReferencesCommentsAndOtherSettings(t *testing.T) {
	cases := []struct {
		client, format, raw, reference string
		pointer                        []string
	}{
		{"cursor", "jsonc", `{// keep
"theme":true,"mcpServers":{"test":{"command":"echo","args":["${env:NATIVE}"],"description":"before","unknown":{"keep":true}}}}`, "${env:NATIVE}", []string{"mcpServers", "test"}},
		{"claude", "jsonc", `{"theme":true,"projects":{"/project":{"mcpServers":{"test":{"command":"echo","env":{"TOKEN":"${NATIVE:-local}"},"description":"before","unknown":{"keep":true}}}}}}`, "${NATIVE:-local}", []string{"projects", "/project", "mcpServers", "test"}},
		{"codex", "toml", "# keep\ntheme=true\n[mcp_servers.test]\ncommand='echo'\nenv_vars=['NATIVE']\ndescription='before'\nunknown={keep=true}\n", "env_vars=['NATIVE']", []string{"mcp_servers", "test"}},
		{"pi", "jsonc", `{// keep
"settings":{"debug":false},"mcpServers":{"test":{"command":"echo","env":{"TOKEN":"!never-execute"},"description":"before","unknown":{"keep":true}}}}`, "!never-execute", []string{"mcpServers", "test"}},
	}
	for _, tt := range cases {
		t.Run(tt.client, func(t *testing.T) {
			root, err := documents.Parse([]byte(tt.raw), tt.format)
			if err != nil {
				t.Fatal(err)
			}
			value, _ := documents.At(root, tt.pointer)
			entry := value.(map[string]any)
			entry["description"] = "after"
			output, err := documents.Edit([]byte(tt.raw), tt.format, tt.pointer, entry)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(output), tt.reference) || !strings.Contains(string(output), "keep") {
				t.Fatal("unrelated client syntax changed", string(output))
			}
			parsed, err := documents.Parse(output, tt.format)
			if err != nil {
				t.Fatal(err)
			}
			actual, _ := documents.At(parsed, tt.pointer)
			if actual.(map[string]any)["description"] != "after" {
				t.Fatal("edit did not reach selected entry")
			}
		})
	}
}
