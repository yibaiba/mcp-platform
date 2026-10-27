package mcpclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mcplatform/connector/internal/processtree"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type Config struct {
	Lifecycle struct {
		ShutdownGraceMS *int `json:"shutdownGraceMs"`
	} `json:"lifecycle"`
	Transport string            `json:"transport"`
	Mode      string            `json:"mode"`
	URL       string            `json:"url"`
	Command   string            `json:"command"`
	Args      []string          `json:"args"`
	Env       map[string]string `json:"env"`
	Headers   map[string]string `json:"headers"`
	Cwd       string            `json:"cwd"`
}
type Params struct {
	SessionID      string                       `json:"sessionId"`
	BindingID      string                       `json:"bindingId"`
	Capabilities   map[string]any               `json:"capabilities"`
	CorrelationID  string                       `json:"correlationId"`
	ConnectionID   string                       `json:"connectionId"`
	Config         Config                       `json:"config"`
	Name           string                       `json:"name"`
	Arguments      map[string]any               `json:"arguments"`
	Operation      Operation                    `json:"operation"`
	ProgressToken  string                       `json:"progressToken"`
	RequestState   string                       `json:"requestState"`
	InputResponses map[string]*mcp.ElicitResult `json:"inputResponses"`
}

func (p Params) key() string {
	if p.SessionID != "" {
		return p.SessionID
	}
	return p.ConnectionID
}

type Entry struct {
	Tree          *processtree.Tree
	Grace         time.Duration
	Session       *mcp.ClientSession
	cancelSession context.CancelFunc
	Process       *exec.Cmd
	Fingerprint   string
	LastError     string
}
type Manager struct {
	interactiveMu sync.Mutex
	interactive   map[string]*legacyCall
	callSlots     map[string]chan struct{}
	mu            sync.Mutex
	entries       map[string]*Entry
	ctx           context.Context
	stderr        io.Writer
	transport     http.RoundTripper
	notifyMu      sync.RWMutex
	notify        func(Notification)
}

func New(ctx context.Context, stderr io.Writer, transport http.RoundTripper) *Manager {
	return &Manager{entries: make(map[string]*Entry), ctx: ctx, stderr: stderr, transport: transport}
}
func (m *Manager) Execute(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	var p Params
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	if p.ConnectionID == "" {
		return nil, fmt.Errorf("connectionId is required")
	}
	if method == "close" {
		return map[string]bool{"closed": true}, m.Close(p.key())
	}
	if method == "interaction.cancel" {
		return m.cancelInteraction(p)
	}
	session, err := m.connect(ctx, p)
	if err != nil {
		return nil, err
	}
	switch method {
	case "catalog":
		return discoverCatalog(ctx, session)
	case "mcp.request":
		return requestOperation(ctx, session, p)
	case "discover":
		result, err := collect(session.Tools(ctx, nil))
		return &mcp.ListToolsResult{Tools: result}, err
	case "call":
		return m.call(ctx, session, p)
	case "check":
		if session.InitializeResult().ProtocolVersion >= "2026-07-28" {
			_, err := mcp.CallCustomMethod[*mcp.DiscoverParams, *mcp.DiscoverResult](ctx, session, "server/discover", &mcp.DiscoverParams{})
			return map[string]bool{"healthy": err == nil}, err
		}
		return map[string]bool{"healthy": true}, session.Ping(ctx, nil)
	default:
		return nil, fmt.Errorf("unknown MCP method: %s", method)
	}
}
func (m *Manager) recordError(id string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e := m.entries[id]; e != nil {
		e.LastError = err.Error()
	}
}
func (m *Manager) connect(ctx context.Context, p Params) (*mcp.ClientSession, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	encoded, err := json.Marshal(p.Config)
	if err != nil {
		return nil, err
	}
	e := m.entries[p.key()]
	if e != nil && e.Fingerprint != string(encoded) {
		if err := closeEntry(e); err != nil {
			return nil, err
		}
		delete(m.entries, p.key())
		e = nil
	}
	if e == nil {
		e = &Entry{Fingerprint: string(encoded)}
		m.entries[p.key()] = e
	}
	if e.Session != nil {
		return e.Session, nil
	}
	transport, err := m.makeTransport(p.Config, e)
	if err != nil {
		e.LastError = err.Error()
		return nil, err
	}
	e.Session, e.cancelSession, err = m.openSession(ctx, transport, p)
	if err != nil {
		e.LastError = err.Error()
		cleanup := closeEntry(e)
		delete(m.entries, p.key())
		return nil, errors.Join(err, cleanup)
	}
	e.LastError = ""
	return e.Session, nil
}
func (m *Manager) openSessionFor(ctx context.Context, transport mcp.Transport, connectionID string, sessionIDs ...string) (*mcp.ClientSession, context.CancelFunc, error) {
	p := Params{ConnectionID: connectionID}
	if len(sessionIDs) > 0 {
		p.SessionID = sessionIDs[0]
	}
	return m.openSession(ctx, transport, p)
}
func (m *Manager) openSession(ctx context.Context, transport mcp.Transport, p Params) (*mcp.ClientSession, context.CancelFunc, error) {
	// The SSE GET must outlive discovery, while request cancellation still interrupts initialization.
	sessionCtx, cancel := context.WithCancel(m.ctx)
	stop := context.AfterFunc(ctx, cancel)
	options := m.clientOptions(p.ConnectionID, p.SessionID)
	if p.Capabilities != nil {
		encoded, err := json.Marshal(p.Capabilities)
		if err != nil {
			cancel()
			return nil, nil, err
		}
		options.Capabilities = &mcp.ClientCapabilities{}
		if err := json.Unmarshal(encoded, options.Capabilities); err != nil {
			cancel()
			return nil, nil, err
		}
		if options.Capabilities.Elicitation != nil {
			options.ElicitationHandler = func(ctx context.Context, req *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
				return m.elicit(ctx, p.key(), req)
			}
		}
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "mcp-platform-connector", Version: "0.1.0"}, options)
	session, err := client.Connect(sessionCtx, transport, nil)
	detached := stop()
	if err != nil {
		cancel()
		return nil, nil, err
	}
	if !detached {
		cancel()
		return nil, nil, errors.Join(ctx.Err(), session.Close())
	}
	return session, cancel, nil
}
func (m *Manager) command(c Config) *exec.Cmd {
	cmd := exec.CommandContext(m.ctx, c.Command, c.Args...)
	cmd.Dir = c.Cwd
	cmd.Stderr = m.stderr
	cmd.Env = os.Environ()
	for key, value := range c.Env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	return cmd
}
func (m *Manager) makeTransport(c Config, e *Entry) (mcp.Transport, error) {
	if c.Transport == "stdio" {
		if c.Mode != "managed" || c.Command == "" {
			return nil, fmt.Errorf("stdio requires managed command")
		}
		command := m.command(c)
		stdin, err := command.StdinPipe()
		if err != nil {
			return nil, err
		}
		stdout, err := command.StdoutPipe()
		if err != nil {
			stdin.Close()
			return nil, err
		}
		tree, err := processtree.Start(command)
		if err != nil {
			stdin.Close()
			stdout.Close()
			return nil, err
		}
		e.Tree = tree
		e.Grace = shutdownGrace(c)
		return &mcp.IOTransport{Reader: stdout, Writer: stdin}, nil
	}
	if c.URL == "" {
		return nil, fmt.Errorf("HTTP MCP requires URL")
	}
	if c.Transport != "http" && c.Transport != "sse" {
		return nil, fmt.Errorf("unsupported transport: %s", c.Transport)
	}
	if c.Mode == "managed" && e.Process == nil {
		if c.Command == "" {
			return nil, fmt.Errorf("managed service requires command")
		}
		cmd := m.command(c)
		cmd.Stdout = m.stderr
		tree, err := processtree.Start(cmd)
		if err != nil {
			return nil, err
		}
		e.Tree = tree
		e.Grace = shutdownGrace(c)
		e.Process = cmd
	}
	client := &http.Client{Transport: headerTransport{base: m.transport, headers: c.Headers, endpoint: c.URL}, CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
	switch c.Transport {
	case "http":
		return &mcp.StreamableClientTransport{Endpoint: c.URL, HTTPClient: client, MaxRetries: -1}, nil
	case "sse":
		return &mcp.SSEClientTransport{Endpoint: c.URL, HTTPClient: client}, nil
	default:
		return nil, fmt.Errorf("unsupported transport: %s", c.Transport)
	}
}

type headerTransport struct {
	base     http.RoundTripper
	headers  map[string]string
	endpoint string
}

func (t headerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	endpoint, err := url.Parse(t.endpoint)
	if err != nil {
		return nil, err
	}
	if r.URL.Scheme != endpoint.Scheme || r.URL.Host != endpoint.Host {
		return nil, fmt.Errorf("MCP header credentials cannot cross origins")
	}
	copy := r.Clone(r.Context())
	for key, value := range t.headers {
		copy.Header.Set(key, value)
	}
	return t.base.RoundTrip(copy)
}
func closeEntry(e *Entry) error {
	if e.cancelSession != nil {
		defer e.cancelSession()
	}
	var errors []string
	if e.Session != nil {
		if err := e.Session.Close(); err != nil {
			errors = append(errors, err.Error())
		}
	}
	if e.Tree != nil {
		if err := e.Tree.Stop(e.Grace); err != nil {
			errors = append(errors, err.Error())
		}
		e.Tree = nil
	}

	if len(errors) > 0 {
		return fmt.Errorf("%s", strings.Join(errors, "; "))
	}
	return nil
}
func (m *Manager) Close(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	e := m.entries[id]
	delete(m.entries, id)
	if e == nil {
		return nil
	}
	return closeEntry(e)
}
func (m *Manager) CloseAll() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	var errors []string
	for id, e := range m.entries {
		if err := closeEntry(e); err != nil {
			errors = append(errors, err.Error())
		}
		delete(m.entries, id)
	}
	if len(errors) > 0 {
		return fmt.Errorf("%s", strings.Join(errors, "; "))
	}
	return nil
}
func (m *Manager) Status() []map[string]string {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := []map[string]string{}
	for id, e := range m.entries {
		status := "connected"
		if e.Session == nil || e.LastError != "" {
			status = "error"
		}
		result = append(result, map[string]string{"id": id, "status": status, "error": e.LastError})
	}
	return result
}

func shutdownGrace(c Config) time.Duration {
	if c.Lifecycle.ShutdownGraceMS == nil {
		return 5 * time.Second
	}
	return time.Duration(*c.Lifecycle.ShutdownGraceMS) * time.Millisecond
}
