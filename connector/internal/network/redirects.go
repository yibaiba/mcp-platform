package network

import (
	"fmt"
	"net/http"
	"strings"
)

const maxRedirects = 20 // Match the Fetch redirect limit used by the platform.

// net/http resolves Location against the caller's URL, not a transport-rewritten URL.
func resolveRedirect(response *http.Response) error {
	switch response.StatusCode {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther, http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
	default:
		return nil
	}
	if response.Header.Get("Location") == "" {
		return nil
	}
	target, err := response.Location()
	if err != nil {
		return fmt.Errorf("invalid accelerator redirect location")
	}
	response.Header.Set("Location", target.String())
	return nil
}

func Redirect(req *http.Request, via []*http.Request) error {
	if len(via) >= maxRedirects {
		return fmt.Errorf("too many redirects")
	}
	previous := redirectSource(req, via)
	// Carry only the headers actually sent to the previous endpoint, including its
	// independent accelerator token. Never resurrect the original origin's credentials.
	req.Header = previous.Header.Clone()
	if req.URL.Host != previous.URL.Host || req.URL.Scheme != previous.URL.Scheme {
		github := previous.URL.Hostname() == "github.com" || strings.HasSuffix(previous.URL.Hostname(), ".github.com")
		if github && req.Body != nil && req.Body != http.NoBody {
			return fmt.Errorf("cannot redirect a GitHub request body to another origin")
		}
		strip(req.Header)
	}
	if req.Method != previous.Method {
		req.Header.Del("Content-Type")
		req.Header.Del("Content-Length")
	}
	return nil
}

func redirectSource(req *http.Request, via []*http.Request) *http.Request {
	if req.Response != nil && req.Response.Request != nil {
		return req.Response.Request
	}
	return via[len(via)-1]
}
