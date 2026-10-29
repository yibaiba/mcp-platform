package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/files"
	"mcplatform/connector/internal/local"
	"mcplatform/connector/internal/local/model"
	"mcplatform/connector/internal/mcpclient"
)

type Dispatch struct {
	PackagePreview func(json.RawMessage) (any, error)
	PackageCheck   func(context.Context, json.RawMessage) (any, error)
	Local          *local.Service
	MCP            *mcpclient.Manager
	Skills         *files.SkillInstaller
	Artifacts      *files.ArtifactTransfer
}

func (d *Dispatch) Execute(ctx context.Context, method string, params json.RawMessage) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	switch method {
	case "local.request":
		if d.Local == nil {
			return nil, fmt.Errorf("local management unavailable")
		}
		var request model.Request
		if err := json.Unmarshal(params, &request); err != nil {
			return nil, err
		}
		return d.Local.Execute(ctx, request, true)
	case "package.preview":
		if d.PackagePreview != nil {
			return d.PackagePreview(params)
		}
		if d.Local == nil {
			return nil, fmt.Errorf("package preview unavailable")
		}
		return d.Local.PreviewPackage(params)
	case "package.check":
		if d.PackageCheck != nil {
			return d.PackageCheck(ctx, params)
		}
		if d.Local == nil {
			return nil, fmt.Errorf("package checks unavailable")
		}
		return d.Local.CheckPackage(ctx, params)
	case "oauth.request":
		return d.MCP.OAuthRequest(ctx, params)
	case "discover", "catalog", "mcp.request", "call", "close", "check", "interaction.cancel":
		if d.Local != nil && method != "close" && method != "interaction.cancel" {
			resolved, err := d.Local.Resolve(params)
			if err != nil {
				return nil, err
			}
			params = resolved
		}
		return d.MCP.Execute(ctx, method, params)
	case "skill.install":
		return d.Skills.Install(params)
	case "artifact.send", "artifact.receive":
		return d.Artifacts.Execute(ctx, method, params)
	default:
		return nil, fmt.Errorf("unsupported operation: %s", method)
	}
}
func (d *Dispatch) Status() []map[string]string { return d.MCP.Status() }
func (d *Dispatch) Disconnected() error         { return d.MCP.CloseAll() }

func (d *Dispatch) SetNotifier(notify func(mcpclient.Notification)) { d.MCP.SetNotifier(notify) }

func (d *Dispatch) SetLocalNotifier(notify func()) {
	if d.Local != nil {
		d.Local.SetNotifier(notify)
	}
}

func (d *Dispatch) Capabilities() []string {
	values := []string{"sessions", "health", "oauth", "elicitation", "apps"}
	if d.PackageCheck != nil {
		values = append(values, "package-updates")
	}
	if d.Local != nil {
		values = append(values, "local-management", "local-sync", "package-updates")
	}
	return values
}
