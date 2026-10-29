package sources

import (
	"context"
	"fmt"
	"mcplatform/connector/internal/local/documents"
	"mcplatform/connector/internal/local/model"
	"os"
	"path/filepath"
	"slices"
	"sort"
)

func Scan(ctx context.Context, list []model.Source) (map[string]model.Resource, []string) {
	result := map[string]model.Resource{}
	issues := []string{}
	for _, source := range list {
		if err := ctx.Err(); err != nil {
			issues = append(issues, err.Error())
			break
		}
		resources, errors := scanSource(source)
		issues = append(issues, errors...)
		for _, r := range resources {
			if previous, ok := result[r.ID]; ok {
				r.SourceIDs = appendUnique(previous.SourceIDs, source.ID)
				r.Clients = appendUnique(previous.Clients, source.Client)
				r.ReadOnly = r.ReadOnly || previous.ReadOnly
				r.ProgramExists = r.ProgramExists || previous.ProgramExists
				for _, issue := range previous.Issues {
					r.Issues = appendUnique(r.Issues, issue)
				}
			}
			result[r.ID] = r
		}
	}
	return result, issues
}
func appendUnique(values []string, value string) []string {
	if slices.Contains(values, value) {
		return values
	}
	return append(values, value)
}
func scanSource(source model.Source) ([]model.Resource, []string) {
	if source.Kind == "skill" {
		return scanSkills(source)
	}
	info, err := os.Stat(source.Path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, []string{fmt.Sprintf("%s: %v", source.Path, err)}
	}
	if !info.Mode().IsRegular() {
		return nil, []string{source.Path + ": configuration must be a regular file"}
	}
	data, err := os.ReadFile(source.Path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, []string{fmt.Sprintf("%s: %v", source.Path, err)}
	}
	root, err := documents.Parse(data, source.Format)
	if err != nil {
		return nil, []string{source.Path + ": " + err.Error()}
	}
	value, exists := documents.At(root, source.Pointer)
	if !exists {
		return nil, nil
	}
	entries, ok := value.(map[string]any)
	if !ok {
		return nil, []string{source.Path + ": MCP entries must be an object"}
	}
	real, err := filepath.EvalSymlinks(source.Path)
	if err != nil {
		return nil, []string{source.Path + ": " + err.Error()}
	}
	result := []model.Resource{}
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		pointer := append(append([]string{}, source.Pointer...), name)
		r := model.Resource{ID: ID(real, documents.Pointer(pointer)), Kind: "mcp", Name: name, SourceIDs: []string{source.ID}, Clients: []string{source.Client}, Project: source.Project, Path: source.Path, RealPath: real, Pointer: pointer, Content: documents.Encode(entries[name]), FileDigest: documents.Digest(data), ReadOnly: source.ReadOnly, Runtime: "client-managed", Issues: []string{}}
		r.Digest = documents.Digest(r.Content)
		entry, ok := entries[name].(map[string]any)
		if !ok {
			r.Issues = append(r.Issues, "MCP entry must be an object")
		} else {
			r.Description, _ = entry["description"].(string)
			r.Issues = append(r.Issues, Inspect(entry, source)...)
			r.ProgramExists = programExists(entry, source)
		}
		result = append(result, r)
	}
	return result, nil
}
