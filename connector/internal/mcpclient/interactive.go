package mcpclient

import (
	"context"
	"crypto/rand"
	"fmt"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type callBoundary struct {
	result any
	err    error
}
type legacyCall struct {
	boundary chan callBoundary
	answer   chan *mcp.ElicitResult
	token    string
	question string
	abort    context.CancelFunc
}

func (m *Manager) call(ctx context.Context, session *mcp.ClientSession, p Params) (any, error) {
	params := &mcp.CallToolParams{Name: p.Name, Arguments: p.Arguments, RequestState: p.RequestState}
	if p.ProgressToken != "" {
		params.SetProgressToken(p.ProgressToken)
	}
	if session.InitializeResult().ProtocolVersion >= "2026-07-28" {
		if p.InputResponses != nil {
			params.InputResponses = mcp.InputResponseMap{}
			for id, response := range p.InputResponses {
				params.InputResponses[id] = response
			}
		}
		result, err := session.CallTool(ctx, params)
		if err != nil {
			m.recordError(p.key(), err)
			return nil, &DeliveryError{Cause: err}
		}
		return result, nil
	}
	if p.RequestState != "" {
		return m.resumeLegacy(ctx, p)
	}
	return m.startLegacy(ctx, session, p, params)
}
func (m *Manager) slot(key string) chan struct{} {
	m.interactiveMu.Lock()
	defer m.interactiveMu.Unlock()
	if m.callSlots == nil {
		m.callSlots = map[string]chan struct{}{}
		m.interactive = map[string]*legacyCall{}
	}
	if m.callSlots[key] == nil {
		m.callSlots[key] = make(chan struct{}, 1)
	}
	return m.callSlots[key]
}
func (m *Manager) startLegacy(ctx context.Context, session *mcp.ClientSession, p Params, params *mcp.CallToolParams) (any, error) {
	slot := m.slot(p.key())
	select {
	case slot <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	lifetime, abort := context.WithCancel(m.ctx)
	state := &legacyCall{boundary: make(chan callBoundary, 1), abort: abort}
	m.interactiveMu.Lock()
	m.interactive[p.key()] = state
	m.interactiveMu.Unlock()
	go func() {
		defer abort()
		defer func() { <-slot }()
		result, err := session.CallTool(lifetime, params)
		m.interactiveMu.Lock()
		delete(m.interactive, p.key())
		m.interactiveMu.Unlock()
		state.boundary <- callBoundary{result, err}
	}()
	return waitLegacy(ctx, state)
}
func waitLegacy(ctx context.Context, state *legacyCall) (any, error) {
	select {
	case result := <-state.boundary:
		if result.err != nil {
			return nil, &DeliveryError{Cause: result.err}
		}
		return result.result, nil
	case <-ctx.Done():
		state.abort()
		return nil, ctx.Err()
	}
}
func (m *Manager) elicit(ctx context.Context, key string, req *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
	m.interactiveMu.Lock()
	state := m.interactive[key]
	if state == nil || state.answer != nil {
		m.interactiveMu.Unlock()
		return nil, fmt.Errorf("elicitation has no unambiguous parent call")
	}
	state.question, state.token = rand.Text(), rand.Text()
	answer := make(chan *mcp.ElicitResult, 1)
	state.answer = answer
	result := map[string]any{"resultType": "input_required", "requestState": state.token, "inputRequests": map[string]any{state.question: map[string]any{"method": "elicitation/create", "params": req.Params}}}
	m.interactiveMu.Unlock()
	state.boundary <- callBoundary{result: result}
	select {
	case response := <-answer:
		return response, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func (m *Manager) resumeLegacy(ctx context.Context, p Params) (any, error) {
	m.interactiveMu.Lock()
	state := m.interactive[p.key()]
	if state == nil || state.token != p.RequestState || state.answer == nil || p.InputResponses[state.question] == nil {
		m.interactiveMu.Unlock()
		return nil, fmt.Errorf("legacy interaction state ended or mismatched")
	}
	answer := state.answer
	state.answer = nil
	state.token = ""
	response := p.InputResponses[state.question]
	m.interactiveMu.Unlock()
	answer <- response
	return waitLegacy(ctx, state)
}

func (m *Manager) cancelInteraction(p Params) (any, error) {
	m.interactiveMu.Lock()
	defer m.interactiveMu.Unlock()
	state := m.interactive[p.key()]
	if state == nil {
		return map[string]bool{"cancelled": false}, nil
	}
	if state.token != p.RequestState {
		return nil, fmt.Errorf("legacy interaction state ended or mismatched")
	}
	state.abort()
	return map[string]bool{"cancelled": true}, nil
}
