package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/files"
	"mcplatform/connector/internal/mcpclient"
)

type Dispatch struct {
	MCP       *mcpclient.Manager
	Skills    *files.SkillInstaller
	Artifacts *files.ArtifactTransfer
}

func (d *Dispatch) Execute(ctx context.Context, method string, params json.RawMessage) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	switch method {
	case "oauth.request":
		return d.MCP.OAuthRequest(ctx, params)
	case "discover", "catalog", "mcp.request", "call", "close", "check", "interaction.cancel":
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
