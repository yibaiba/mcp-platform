package network

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

type Settings struct {
	HTTPProxy            string `json:"httpProxy"`
	HTTPSProxy           string `json:"httpsProxy"`
	NoProxy              string `json:"noProxy"`
	NPMRegistry          string `json:"npmRegistry"`
	PythonIndex          string `json:"pythonIndex"`
	ReplacePublicSources bool   `json:"replacePublicSources"`
	GitHubAPI            string `json:"githubApi"`
	GitHubDownload       string `json:"githubDownload"`
	GitHubClone          string `json:"githubClone"`
}
type Config struct {
	Settings
	Secrets map[string]string `json:"secrets"`
}
type View struct {
	Revision int             `json:"revision"`
	Settings Settings        `json:"settings"`
	Secrets  map[string]bool `json:"secrets"`
}
type Edit struct {
	Action string `json:"action"`
	Value  string `json:"value"`
}
type Save struct {
	Revision int             `json:"revision"`
	Settings Settings        `json:"settings"`
	Secrets  map[string]Edit `json:"secrets"`
}

var SecretNames = []string{"httpProxyAuth", "httpsProxyAuth", "githubApiToken", "githubDownloadToken", "githubCloneToken"}

func endpoint(raw string) error {
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Fragment != "" || u.RawQuery != "" {
		return fmt.Errorf("endpoint must be HTTP(S), without credentials, query or fragment")
	}
	return nil
}
func validateTemplate(raw string, clone bool) error {
	if raw == "" {
		return nil
	}
	tokens := regexp.MustCompile(`\{[^{}]*\}`).FindAllString(raw, -1)
	required := []string{"{url}", "{encodedUrl}"}
	if clone {
		required = []string{"{owner}", "{repo}"}
	}
	for _, token := range tokens {
		if token != required[0] && token != required[1] {
			return fmt.Errorf("unsupported template placeholder")
		}
	}
	if (!clone && len(tokens) != 1) || (clone && (!strings.Contains(raw, required[0]) || !strings.Contains(raw, required[1]))) {
		return fmt.Errorf("missing template placeholder")
	}
	replaced := strings.NewReplacer("{url}", "https://github.com/owner/repo", "{encodedUrl}", "https%3A%2F%2Fgithub.com%2Fowner%2Frepo", "{owner}", "owner", "{repo}", "repo").Replace(raw)
	u, err := url.Parse(replaced)
	if err != nil || u.User != nil || u.Fragment != "" || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return fmt.Errorf("invalid template URL")
	}
	original := strings.SplitN(raw, "://", 2)
	if len(original) != 2 || strings.Contains(strings.SplitN(original[1], "/", 2)[0], "{") {
		return fmt.Errorf("template host must be fixed")
	}
	return nil
}
func (s Settings) Validate() error {
	for _, raw := range []string{s.HTTPProxy, s.HTTPSProxy, s.NPMRegistry, s.PythonIndex, s.GitHubAPI} {
		if err := endpoint(raw); err != nil {
			return err
		}
	}
	if err := validateTemplate(s.GitHubDownload, false); err != nil {
		return err
	}
	return validateTemplate(s.GitHubClone, true)
}
func ParseSave(raw json.RawMessage) (Save, error) {
	var save Save
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&save); err != nil {
		return save, err
	}
	return save, save.Settings.Validate()
}
