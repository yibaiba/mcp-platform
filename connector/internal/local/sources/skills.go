package sources

import (
	"encoding/base64"
	"fmt"
	"io/fs"
	"mcplatform/connector/internal/files"
	"mcplatform/connector/internal/local/documents"
	"mcplatform/connector/internal/local/model"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

func ReadSkill(root string) (map[string][]byte, error) {
	result := map[string][]byte{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("skill contains symlink: %s; select its real target separately", path)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("skill contains a special file: %s", path)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		result[filepath.ToSlash(relative)] = data
		return nil
	})
	return result, err
}
func SkillContent(tree map[string][]byte) []byte {
	encoded := map[string]string{}
	for path, data := range tree {
		encoded[path] = base64.StdEncoding.EncodeToString(data)
	}
	return documents.Encode(encoded)
}
func DecodeSkill(content []byte) (map[string][]byte, error) {
	object, err := documents.Object(content)
	if err != nil {
		return nil, err
	}
	tree := map[string][]byte{}
	for path, value := range object {
		if _, err := files.SafePath(filepath.Join(string(filepath.Separator), "skill"), path); err != nil {
			return nil, err
		}
		text, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("skill files must be base64 strings")
		}
		data, err := base64.StdEncoding.Strict().DecodeString(text)
		if err != nil {
			return nil, fmt.Errorf("invalid base64 skill file: %s", path)
		}
		tree[path] = data
	}
	if _, ok := tree["SKILL.md"]; !ok {
		return nil, fmt.Errorf("SKILL.md is required")
	}
	return tree, nil
}
func metadata(data []byte) (string, string, error) {
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return "", "", fmt.Errorf("SKILL.md requires YAML frontmatter")
	}
	end := strings.Index(text[4:], "\n---")
	if end < 0 {
		return "", "", fmt.Errorf("invalid SKILL.md frontmatter")
	}
	var meta struct {
		Name        string `yaml:"name"`
		Description string `yaml:"description"`
	}
	if err := yaml.Unmarshal([]byte(text[4:4+end]), &meta); err != nil {
		return "", "", fmt.Errorf("invalid SKILL.md YAML")
	}
	if meta.Name == "" || meta.Description == "" {
		return meta.Name, meta.Description, fmt.Errorf("skill name and description are required")
	}
	return meta.Name, meta.Description, nil
}
func scanSkills(source model.Source) ([]model.Resource, []string) {
	return scanSkillDirectory(source, map[string]bool{})
}
func scanSkillDirectory(source model.Source, ancestors map[string]bool) ([]model.Resource, []string) {
	realRoot, err := filepath.EvalSymlinks(source.Path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, []string{source.Path + ": " + err.Error()}
	}
	if ancestors[realRoot] {
		return nil, []string{source.Path + ": symlink directory cycle"}
	}
	ancestors[realRoot] = true
	defer delete(ancestors, realRoot)

	entries, err := os.ReadDir(source.Path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, []string{source.Path + ": " + err.Error()}
	}
	result := []model.Resource{}
	issues := []string{}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".local-") {
			continue
		}
		path := filepath.Join(source.Path, entry.Name())
		real, err := filepath.EvalSymlinks(path)
		if err != nil {
			issues = append(issues, path+": "+err.Error())
			continue
		}
		info, err := os.Stat(real)
		if err != nil {
			issues = append(issues, path+": "+err.Error())
			continue
		}
		if !info.IsDir() {
			continue
		}
		if _, err := os.Stat(filepath.Join(real, "SKILL.md")); os.IsNotExist(err) {
			nested, nestedIssues := scanSkillDirectory(model.Source{ID: source.ID, Client: source.Client, Kind: source.Kind, Path: real, Project: source.Project, ReadOnly: source.ReadOnly || strings.HasPrefix(entry.Name(), ".")}, ancestors)
			result = append(result, nested...)
			issues = append(issues, nestedIssues...)
			continue
		}
		tree, err := ReadSkill(real)
		if err != nil {
			issues = append(issues, path+": "+err.Error())
			continue
		}
		name, description, err := metadata(tree["SKILL.md"])
		localIssues := []string{}
		if err != nil {
			localIssues = append(localIssues, err.Error())
		}
		if name == "" {
			name = entry.Name()
		}
		content := SkillContent(tree)
		result = append(result, model.Resource{ID: ID(real, "skill"), Kind: "skill", Name: name, Description: description, SourceIDs: []string{source.ID}, Clients: []string{source.Client}, Project: source.Project, Path: path, RealPath: real, Content: content, Digest: documents.Digest(content), FileDigest: files.Digest(tree), ReadOnly: source.ReadOnly || strings.Contains(filepath.ToSlash(real), "/.system/"), Runtime: "client-managed", Issues: localIssues})
	}
	return result, issues
}
