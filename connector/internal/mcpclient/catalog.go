package mcpclient

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"iter"
)

type Catalog struct {
	ServerInfo      *mcp.Implementation     `json:"serverInfo,omitempty"`
	Instructions    string                  `json:"instructions,omitempty"`
	Tools           []*mcp.Tool             `json:"tools"`
	Prompts         []*mcp.Prompt           `json:"prompts"`
	Resources       []*mcp.Resource         `json:"resources"`
	Templates       []*mcp.ResourceTemplate `json:"templates"`
	ProtocolVersion string                  `json:"protocolVersion"`
	Capabilities    *mcp.ServerCapabilities `json:"capabilities"`
}

func collect[T any](sequence iter.Seq2[T, error]) ([]T, error) {
	items := []T{}
	for item, err := range sequence {
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

func discoverCatalog(ctx context.Context, session *mcp.ClientSession) (*Catalog, error) {
	initialized := session.InitializeResult()
	result := &Catalog{ServerInfo: initialized.ServerInfo, Instructions: initialized.Instructions, Tools: []*mcp.Tool{}, Prompts: []*mcp.Prompt{}, Resources: []*mcp.Resource{}, Templates: []*mcp.ResourceTemplate{}, ProtocolVersion: initialized.ProtocolVersion, Capabilities: initialized.Capabilities}
	var err error
	if result.Capabilities.Tools != nil {
		result.Tools, err = collect(session.Tools(ctx, nil))
		if err != nil {
			return nil, err
		}
	}
	if result.Capabilities.Prompts != nil {
		result.Prompts, err = collect(session.Prompts(ctx, nil))
		if err != nil {
			return nil, err
		}
	}
	if result.Capabilities.Resources != nil {
		result.Resources, err = collect(session.Resources(ctx, nil))
		if err != nil {
			return nil, err
		}
		result.Templates, err = collect(session.ResourceTemplates(ctx, nil))
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}

type Operation struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

func requestOperation(ctx context.Context, session *mcp.ClientSession, p Params) (any, error) {
	switch p.Operation.Method {
	case "prompts/get":
		var params mcp.GetPromptParams
		if err := json.Unmarshal(p.Operation.Params, &params); err != nil {
			return nil, err
		}
		if p.ProgressToken != "" {
			params.SetProgressToken(p.ProgressToken)
		}
		return session.GetPrompt(ctx, &params)
	case "resources/read":
		var params mcp.ReadResourceParams
		if err := json.Unmarshal(p.Operation.Params, &params); err != nil {
			return nil, err
		}
		if p.ProgressToken != "" {
			params.SetProgressToken(p.ProgressToken)
		}
		return session.ReadResource(ctx, &params)
	case "resources/subscribe":
		var params mcp.SubscribeParams
		if err := json.Unmarshal(p.Operation.Params, &params); err != nil {
			return nil, err
		}
		return map[string]any{}, session.Subscribe(ctx, &params)
	case "resources/unsubscribe":
		var params mcp.UnsubscribeParams
		if err := json.Unmarshal(p.Operation.Params, &params); err != nil {
			return nil, err
		}
		return map[string]any{}, session.Unsubscribe(ctx, &params)
	default:
		return nil, fmt.Errorf("unsupported MCP operation: %s", p.Operation.Method)
	}
}
