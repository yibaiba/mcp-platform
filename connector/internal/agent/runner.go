package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/coder/websocket"
	"log"
	"mcplatform/connector/internal/config"
	"mcplatform/connector/internal/mcpclient"
	"net/http"
	"os"
	"runtime"
	"sync"
	"time"
)

type Handler interface {
	Execute(context.Context, string, json.RawMessage) (any, error)
	Status() []map[string]string
}
type Runner struct {
	Config  config.Config
	Handler Handler
	Client  *http.Client
	Logger  *log.Logger
}

func (r *Runner) Run(ctx context.Context) error {
	for {
		if ctx.Err() != nil {
			return nil
		}
		err := r.session(ctx)
		if handler, ok := r.Handler.(interface{ Disconnected() error }); ok {
			err = errors.Join(err, handler.Disconnected())
		}
		if ctx.Err() != nil {
			return nil
		}
		r.Logger.Printf("device channel disconnected: %v; reconnecting in %s; requests are not replayed", err, ReconnectDelay)
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(ReconnectDelay):
		}
	}
}
func (r *Runner) session(parent context.Context) error {
	u, err := config.ValidateServer(r.Config.Server)
	if err != nil {
		return err
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = "/api/v1/devices/channel"
	headers := http.Header{"Authorization": []string{"Bearer " + r.Config.Token}}
	conn, resp, err := websocket.Dial(parent, u.String(), &websocket.DialOptions{HTTPClient: r.Client, HTTPHeader: headers})
	if err != nil {
		if resp != nil {
			return fmt.Errorf("channel HTTP %d", resp.StatusCode)
		}
		return err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(-1)
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	hostname, err := os.Hostname()
	if err != nil {
		return err
	}
	if err = r.send(ctx, conn, map[string]any{"v": 1, "type": "hello", "os": runtime.GOOS, "version": Version, "hostname": hostname, "capabilities": []string{"sessions", "health", "oauth", "elicitation", "apps"}}); err != nil {
		return err
	}
	if handler, ok := r.Handler.(interface {
		SetNotifier(func(mcpclient.Notification))
	}); ok {
		handler.SetNotifier(func(event mcpclient.Notification) {
			if err := r.send(ctx, conn, event); err != nil {
				r.Logger.Printf("MCP notification delivery failed: %v", err)
				conn.CloseNow()
			}
		})
		defer handler.SetNotifier(nil)
	}
	go r.heartbeat(ctx, conn)
	return r.read(ctx, conn)
}
func (r *Runner) send(ctx context.Context, conn *websocket.Conn, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, data)
}
func (r *Runner) heartbeat(ctx context.Context, conn *websocket.Conn) {
	ticker := time.NewTicker(HeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := r.send(ctx, conn, map[string]any{"v": 1, "type": "heartbeat", "services": r.Handler.Status()}); err != nil {
				r.Logger.Printf("heartbeat: %v", err)
				conn.CloseNow()
				return
			}
		}
	}
}
func (r *Runner) read(ctx context.Context, conn *websocket.Conn) error {
	var mu sync.Mutex
	active := map[string]context.CancelFunc{}
	var workers sync.WaitGroup
	defer func() {
		mu.Lock()
		for _, cancel := range active {
			cancel()
		}
		mu.Unlock()
		workers.Wait()
	}()
	for {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		msg, err := Decode(raw)
		if err != nil {
			return err
		}
		mu.Lock()
		if msg.Type == "cancel" {
			if cancel := active[msg.ID]; cancel != nil {
				cancel()
			}
			mu.Unlock()
			continue
		}
		if _, exists := active[msg.ID]; exists {
			mu.Unlock()
			return fmt.Errorf("duplicate request ID")
		}
		callCtx, cancel := context.WithDeadline(ctx, msg.Deadline)
		active[msg.ID] = cancel
		mu.Unlock()
		workers.Add(1)
		go func() {
			defer workers.Done()
			defer cancel()
			defer func() { mu.Lock(); delete(active, msg.ID); mu.Unlock() }()
			result, err := r.Handler.Execute(callCtx, msg.Method, msg.Params)
			response := Result{V: 1, Type: "result", ID: msg.ID, Result: result}
			if err != nil {
				response.Result = nil
				code := "EXECUTION_FAILED"
				var coded interface{ Code() string }
				if errors.As(err, &coded) {
					code = coded.Code()
				}
				response.Error = &Error{Code: code, Message: err.Error()}
			}
			if err = r.send(ctx, conn, response); err != nil {
				r.Logger.Printf("result delivery failed for %s; outcome unknown at platform: %v", msg.ID, err)
			}
		}()
	}
}
