package localhttp

import (
	"context"
	"encoding/json"
	"mcplatform/connector/internal/local/model"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type managerFixture struct{ calls int }

func (m *managerFixture) Execute(context.Context, model.Request, bool) (any, error) {
	m.calls++
	return map[string]bool{"read": true}, nil
}
func TestLocalSessionHostOriginAndCSRF(t *testing.T) {
	manager := &managerFixture{}
	server, err := Start(manager)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := server.listener.Close(); err != nil {
			t.Error(err)
		}
	})
	request := func(path, body, origin, cookie, csrf, host string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", server.origin+path, strings.NewReader(body))
		r.Host = host
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", origin)
		r.Header.Set("X-CSRF-Token", csrf)
		if cookie != "" {
			r.Header.Set("Cookie", cookie)
		}
		w := httptest.NewRecorder()
		server.ServeHTTP(w, r)
		return w
	}
	api := "/local-api/v1/request"
	body := `{"action":"state"}`
	if got := request(api, body, server.origin, "", "", server.host).Code; got != 401 {
		t.Fatal(got)
	}
	opening := `{"token":"` + server.openToken + `"}`
	if got := request("/local-api/v1/session", opening, "https://attacker.test", "", "", server.host).Code; got != 403 {
		t.Fatal(got)
	}
	session := request("/local-api/v1/session", opening, server.origin, "", "", server.host)
	if session.Code != 200 {
		t.Fatal(session.Code, session.Body.String())
	}
	var info map[string]string
	if err = json.Unmarshal(session.Body.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	cookie := session.Result().Cookies()[0]
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatal("unsafe cookie")
	}
	header := cookie.Name + "=" + cookie.Value
	if got := request("/local-api/v1/session", opening, server.origin, "", "", server.host).Code; got != 401 {
		t.Fatal("opening token reused", got)
	}
	for _, tt := range []struct{ origin, csrf, host string }{{server.origin, "", server.host}, {"https://attacker.test", info["csrf"], server.host}, {server.origin, info["csrf"], "attacker.test"}} {
		if got := request(api, body, tt.origin, header, tt.csrf, tt.host).Code; got != 403 {
			t.Fatal(got)
		}
	}
	if got := request(api, body, server.origin, header, info["csrf"], server.host).Code; got != 200 || manager.calls != 1 {
		t.Fatal("valid local request failed", got, manager.calls)
	}
}
