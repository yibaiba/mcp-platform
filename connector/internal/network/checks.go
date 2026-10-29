package network

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"time"
)

func CloneURL(raw string, c Config) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if u.Hostname() != "github.com" || c.GitHubClone == "" {
		return raw, nil
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) != 2 || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("GitHub clone URL must specify owner/repo")
	}
	return strings.NewReplacer("{owner}", parts[0], "{repo}", strings.TrimSuffix(parts[1], ".git")).Replace(c.GitHubClone), nil
}
func Check(ctx context.Context, store *Store, client *http.Client) []map[string]any {
	c, _ := store.Snapshot()
	results := []map[string]any{}
	for _, entry := range []struct{ kind, raw string }{{"api", "https://api.github.com/repos/yibaiba/mcp-platform"}, {"download", "https://raw.githubusercontent.com/yibaiba/mcp-platform/main/README.md"}, {"git", "https://github.com/yibaiba/mcp-platform.git"}} {
		target, _ := url.Parse(entry.raw)
		target, _, rewriteErr := Rewrite(target, c)
		raw := target.String()
		callCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		err := rewriteErr
		if entry.kind == "git" {
			raw, err = CloneURL(entry.raw, c)
			if err == nil {
				err = gitCheck(callCtx, raw, c)
			}
		} else if err == nil {
			var req *http.Request
			req, err = http.NewRequestWithContext(callCtx, "HEAD", entry.raw, nil)
			if err == nil {
				var res *http.Response
				res, err = client.Do(req)
				if err == nil {
					res.Body.Close()
					if res.StatusCode >= 400 {
						err = fmt.Errorf("HTTP %d", res.StatusCode)
					}
				}
			}
		}
		cancel()
		detail := "访问成功"
		if err != nil {
			detail = "访问失败；请核对代理、端点、凭证和证书"
		}
		results = append(results, map[string]any{"kind": entry.kind, "url": raw, "ok": err == nil, "detail": detail})
	}
	return results
}
func gitCheck(ctx context.Context, raw string, c Config) error {
	cmd := exec.CommandContext(ctx, "git", "-c", "http.followRedirects=false", "ls-remote", "--", raw, "HEAD")
	prepared, err := Prepare(Command{}, c)
	if err != nil {
		return err
	}
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=" + os.DevNull, "GIT_TERMINAL_PROMPT=0"}
	for k, v := range prepared.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	if token := c.Secrets["githubCloneToken"]; token != "" {
		cmd.Env = append(cmd.Env, "GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=http."+raw+".extraHeader", "GIT_CONFIG_VALUE_0=Authorization: Bearer "+token)
	}
	return cmd.Run()
}
