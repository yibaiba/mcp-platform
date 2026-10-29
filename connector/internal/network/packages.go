package network

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

type PackageResult struct {
	Package         Package  `json:"package"`
	Versions        []string `json:"versions"`
	NetworkRevision int      `json:"networkRevision"`
}

func CheckPackage(ctx context.Context, input Command, store *Store, client *http.Client) (PackageResult, error) {
	c, revision := store.Snapshot()
	p, err := Resolve(input, c)
	if err != nil {
		return PackageResult{}, err
	}
	versions, err := queryPackage(ctx, *p, client)
	if err != nil {
		return PackageResult{}, err
	}
	_, current := store.Snapshot()
	if revision != current {
		return PackageResult{}, fmt.Errorf("network settings changed during package check")
	}
	u, _ := url.Parse(p.Source)
	u.User = nil
	u.RawQuery = ""
	u.Fragment = ""
	p.Source = u.String()
	return PackageResult{Package: *p, Versions: versions, NetworkRevision: revision}, nil
}
func queryPackage(ctx context.Context, p Package, client *http.Client) ([]string, error) {
	name := url.PathEscape(p.Name)
	if p.Ecosystem == "pypi" {
		name = regexp.MustCompile(`[-_.]+`).ReplaceAllString(strings.ToLower(p.Name), "-") + "/"
	}
	target := strings.TrimSuffix(p.Source, "/") + "/" + name
	req, err := http.NewRequestWithContext(ctx, "GET", target, nil)
	if err != nil {
		return nil, fmt.Errorf("invalid package source")
	}
	accept := "application/json"
	if p.Ecosystem == "pypi" {
		accept = "application/vnd.pypi.simple.v1+json, text/html;q=0.9"
	}
	req.Header.Set("Accept", accept)
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("package source request failed; check local network settings")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("package source returned HTTP %d", res.StatusCode)
	}
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, fmt.Errorf("package source response read failed")
	}
	if p.Ecosystem == "npm" {
		var body struct {
			Versions map[string]json.RawMessage `json:"versions"`
		}
		if json.Unmarshal(data, &body) != nil || body.Versions == nil {
			return nil, fmt.Errorf("invalid npm metadata")
		}
		versions := []string{}
		for version := range body.Versions {
			versions = append(versions, version)
		}
		return versions, nil
	}
	return pythonVersions(data, res.Header.Get("Content-Type"))
}
func pythonVersions(data []byte, contentType string) ([]string, error) {
	names := []string{}
	if strings.Contains(contentType, "json") {
		var body struct {
			Files []struct {
				Filename string          `json:"filename"`
				Yanked   json.RawMessage `json:"yanked"`
			} `json:"files"`
		}
		if json.Unmarshal(data, &body) != nil || body.Files == nil {
			return nil, fmt.Errorf("invalid Python simple metadata")
		}
		for _, file := range body.Files {
			if len(file.Yanked) == 0 || string(file.Yanked) == "false" {
				names = append(names, file.Filename)
			}
		}
	} else {
		links := regexp.MustCompile(`(?i)<a\s[^>]*href=["']([^"']+)["'][^>]*>`).FindAllStringSubmatch(string(data), -1)
		for _, link := range links {
			if strings.Contains(strings.ToLower(link[0]), "data-yanked") {
				continue
			}
			u, err := url.Parse(html.UnescapeString(link[1]))
			if err != nil {
				continue
			}
			parts := strings.Split(u.Path, "/")
			names = append(names, parts[len(parts)-1])
		}
	}
	wheel := regexp.MustCompile(`^[^-]+-([^-]+)-.+\.whl$`)
	archive := regexp.MustCompile(`-([0-9][^-]*)\.(?:tar\.gz|tar\.bz2|tar\.xz|zip|tgz)$`)
	versions := []string{}
	seen := map[string]bool{}
	for _, name := range names {
		match := wheel.FindStringSubmatch(name)
		if match == nil {
			match = archive.FindStringSubmatch(name)
		}
		if match != nil && !seen[match[1]] {
			seen[match[1]] = true
			versions = append(versions, match[1])
		}
	}
	return versions, nil
}
