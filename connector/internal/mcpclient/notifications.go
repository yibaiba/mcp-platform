package mcpclient

import (
	"context"
	"fmt"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type Notification struct {
	SessionID    string `json:"sessionId,omitempty"`
	V            int    `json:"v"`
	Type         string `json:"type"`
	ConnectionID string `json:"connectionId"`
	Method       string `json:"method"`
	Params       any    `json:"params,omitempty"`
	RequestID    string `json:"requestId,omitempty"`
}

func (m *Manager) SetNotifier(notify func(Notification)) {
	m.notifyMu.Lock()
	defer m.notifyMu.Unlock()
	m.notify = notify
}

func (m *Manager) emit(event Notification) {
	event.V, event.Type = 1, "notification"
	m.notifyMu.RLock()
	notify := m.notify
	m.notifyMu.RUnlock()
	if notify == nil {
		fmt.Fprintln(m.stderr, "MCP notification could not be delivered: device channel unavailable")
		return
	}
	notify(event)
}

func (m *Manager) clientOptions(id string, sessionIDs ...string) *mcp.ClientOptions {
	sessionID := ""
	if len(sessionIDs) > 0 {
		sessionID = sessionIDs[0]
	}
	return &mcp.ClientOptions{
		MultiRoundTrip: &mcp.MultiRoundTripOptions{Disabled: true},
		ToolListChangedHandler: func(_ context.Context, _ *mcp.ToolListChangedRequest) {
			m.emit(Notification{ConnectionID: id, SessionID: sessionID, Method: "notifications/tools/list_changed"})
		},
		PromptListChangedHandler: func(_ context.Context, _ *mcp.PromptListChangedRequest) {
			m.emit(Notification{ConnectionID: id, SessionID: sessionID, Method: "notifications/prompts/list_changed"})
		},
		ResourceListChangedHandler: func(_ context.Context, _ *mcp.ResourceListChangedRequest) {
			m.emit(Notification{ConnectionID: id, SessionID: sessionID, Method: "notifications/resources/list_changed"})
		},
		ResourceUpdatedHandler: func(_ context.Context, req *mcp.ResourceUpdatedNotificationRequest) {
			m.emit(Notification{ConnectionID: id, SessionID: sessionID, Method: "notifications/resources/updated", Params: req.Params})
		},
		ProgressNotificationHandler: func(_ context.Context, req *mcp.ProgressNotificationClientRequest) {
			requestID, ok := req.Params.ProgressToken.(string)
			if !ok {
				return
			}
			m.emit(Notification{ConnectionID: id, SessionID: sessionID, Method: "notifications/progress", Params: req.Params, RequestID: requestID})
		},
	}
}
