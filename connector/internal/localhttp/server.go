package localhttp

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mcplatform/connector/internal/local/model"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

//go:embed assets
var assets embed.FS

type Manager interface {
	Execute(context.Context, model.Request, bool) (any, error)
}
type Server struct {
	mu                                     sync.Mutex
	manager                                Manager
	host, origin, openToken, session, csrf string
	cookieName                             string
	server                                 *http.Server
	listener                               net.Listener
}

func token() string {
	var data [32]byte
	if _, err := rand.Read(data[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(data[:])
}
func Start(manager Manager) (*Server, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &Server{manager: manager, listener: listener, host: listener.Addr().String(), openToken: token(), session: token(), csrf: token()}
	s.origin = "http://" + s.host
	// Cookies are shared across loopback ports; each instance needs its own name.
	s.cookieName = "mcplatform-local-" + token()
	s.server = &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second}
	return s, nil
}
func (s *Server) OpenURL() string { return s.origin + "/#open=" + s.openToken }
func (s *Server) Serve() error {
	err := s.server.Serve(s.listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
func (s *Server) Close(ctx context.Context) error { return s.server.Shutdown(ctx) }
func same(a, b string) bool                       { return a != "" && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
	if r.Host != s.host {
		failure(w, "Invalid Host", http.StatusForbidden)
		return
	}
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		failure(w, "Cross-site request denied", http.StatusForbidden)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != s.origin {
		failure(w, "Invalid Origin", http.StatusForbidden)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/local-api/") {
		s.api(w, r)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		failure(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	root, err := fs.Sub(assets, "assets")
	if err != nil {
		failure(w, err.Error(), 500)
		return
	}
	if _, err = fs.Stat(root, "index.html"); err != nil {
		failure(w, "Local UI is missing; build with pnpm connector:build", 503)
		return
	}
	http.FileServer(http.FS(root)).ServeHTTP(w, r)
}
func (s *Server) api(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/local-api/v1/session" {
		s.authenticate(w, r)
		return
	}
	cookie, err := r.Cookie(s.cookieName)
	if err != nil || !same(cookie.Value, s.session) {
		failure(w, "Local session required", 401)
		return
	}
	if r.URL.Path != "/local-api/v1/request" {
		failure(w, "Not found", 404)
		return
	}
	if r.Method != "POST" {
		failure(w, "Method not allowed", 405)
		return
	}
	if r.Header.Get("Origin") != s.origin || !same(r.Header.Get("X-CSRF-Token"), s.csrf) {
		failure(w, "Origin and CSRF token required", 403)
		return
	}
	var request model.Request
	if err := decode(r, &request); err != nil {
		failure(w, err.Error(), 400)
		return
	}
	result, err := s.manager.Execute(r.Context(), request, false)
	if err != nil {
		failure(w, err.Error(), 409)
		return
	}
	respond(w, result)
}
func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		cookie, err := r.Cookie(s.cookieName)
		if err != nil || !same(cookie.Value, s.session) {
			failure(w, "Open the one-time link printed by the connector", 401)
			return
		}
		respond(w, map[string]string{"csrf": s.csrf})
		return
	}
	if r.Method != "POST" || r.Header.Get("Origin") != s.origin {
		failure(w, "Same-origin POST required", 403)
		return
	}
	var input struct {
		Token string `json:"token"`
	}
	if err := decode(r, &input); err != nil {
		failure(w, err.Error(), 400)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !same(input.Token, s.openToken) {
		failure(w, "Opening link is invalid or already used", 401)
		return
	}
	s.openToken = ""
	http.SetCookie(w, &http.Cookie{Name: s.cookieName, Value: s.session, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
	respond(w, map[string]string{"csrf": s.csrf})
}
func decode(r *http.Request, target any) error {
	if r.Header.Get("Content-Type") != "application/json" {
		return fmt.Errorf("Content-Type must be application/json")
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("invalid request JSON")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("request must contain a single JSON value")
	}
	return nil
}
func respond(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		return
	}
}
func failure(w http.ResponseWriter, message string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}
