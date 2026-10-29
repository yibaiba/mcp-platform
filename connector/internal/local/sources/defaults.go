package sources

import (
	"fmt"
	"mcplatform/connector/internal/local/documents"
	"mcplatform/connector/internal/local/model"
	"os"
	"path/filepath"
)

type Locations struct{ Home, CodexHome, PiHome, ConfigHome string }

func ID(parts ...string) string { return documents.Digest(documents.Encode(parts)) }
func New(client, kind, path, project string) model.Source {
	format := "jsonc"
	if filepath.Ext(path) == ".toml" {
		format = "toml"
	}
	s := model.Source{Client: client, Kind: kind, Path: filepath.Clean(path), Project: project, Format: format, Pointer: []string{"mcpServers"}}
	if client == "codex" {
		s.Pointer = []string{"mcp_servers"}
	}
	s.ID = ID(client, kind, s.Path, project, documents.Pointer(s.Pointer))
	return s
}
func User(l Locations) []model.Source {
	if l.CodexHome == "" {
		l.CodexHome = filepath.Join(l.Home, ".codex")
	}
	if l.PiHome == "" {
		l.PiHome = filepath.Join(l.Home, ".pi", "agent")
	}
	if l.ConfigHome == "" {
		l.ConfigHome = filepath.Join(l.Home, ".config")
	}
	result := []model.Source{
		New("cursor", "mcp", filepath.Join(l.Home, ".cursor", "mcp.json"), ""),
		New("claude", "mcp", filepath.Join(l.Home, ".claude.json"), ""),
		New("codex", "mcp", filepath.Join(l.CodexHome, "config.toml"), ""),
	}
	for _, path := range []string{filepath.Join(l.PiHome, "mcp.json"), filepath.Join(l.PiHome, "mcp-adapter.json"), filepath.Join(l.ConfigHome, "mcp", "mcp.json"), filepath.Join(l.Home, ".agents", "mcp.json"), filepath.Join(l.Home, ".agents", "mcp", "mcp.json")} {
		result = append(result, New("pi", "mcp", path, ""))
	}
	for client, dir := range map[string]string{"cursor": filepath.Join(l.Home, ".cursor", "skills"), "claude": filepath.Join(l.Home, ".claude", "skills"), "codex": filepath.Join(l.CodexHome, "skills"), "pi": filepath.Join(l.PiHome, "skills")} {
		result = append(result, New(client, "skill", dir, ""), New(client, "skill", filepath.Join(l.Home, ".agents", "skills"), ""))
	}
	return result
}
func Project(home, path string) ([]model.Source, error) {
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("project path must be absolute")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("project is not a directory")
	}
	result := []model.Source{
		New("cursor", "mcp", filepath.Join(path, ".cursor", "mcp.json"), path),
		New("claude", "mcp", filepath.Join(path, ".mcp.json"), path),
		New("codex", "mcp", filepath.Join(path, ".codex", "config.toml"), path),
		New("pi", "mcp", filepath.Join(path, ".mcp.json"), path),
		New("pi", "mcp", filepath.Join(path, ".pi", "mcp.json"), path),
		New("pi", "mcp", filepath.Join(path, ".pi", "mcp-adapter.json"), path),
	}
	local := New("claude", "mcp", filepath.Join(home, ".claude.json"), path)
	local.Pointer = []string{"projects", filepath.Clean(path), "mcpServers"}
	local.ID = ID(local.Client, local.Path, documents.Pointer(local.Pointer))
	result = append(result, local)
	for client, dir := range map[string]string{"cursor": ".cursor", "claude": ".claude", "codex": ".agents", "pi": ".pi"} {
		result = append(result, New(client, "skill", filepath.Join(path, dir, "skills"), path), New(client, "skill", filepath.Join(path, ".agents", "skills"), path))
	}
	return result, nil
}
func Validate(source model.Source) error {
	if !filepath.IsAbs(source.Path) {
		return fmt.Errorf("source path must be absolute")
	}
	if source.Kind != "mcp" && source.Kind != "skill" {
		return fmt.Errorf("unsupported resource kind")
	}
	if source.Client != "cursor" && source.Client != "claude" && source.Client != "codex" && source.Client != "pi" {
		return fmt.Errorf("unsupported client")
	}
	if source.Format != "jsonc" && source.Format != "json" && source.Format != "toml" {
		return fmt.Errorf("unsupported configuration format")
	}
	return nil
}
