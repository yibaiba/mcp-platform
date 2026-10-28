package config

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

func ValidateSecret(secret string) error {
	raw, err := base64.RawURLEncoding.Strict().DecodeString(secret)
	if err != nil || len(raw) != 32 {
		return fmt.Errorf("deviceSecret must be 32-byte unpadded Base64URL; re-pair the device")
	}
	return nil
}

func NormalizeOrigin(raw string) (string, error) {
	u, err := ValidateServer(raw)
	if err != nil {
		return "", err
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return "", fmt.Errorf("server requires a hostname")
	}
	// net/http serializes internationalized Host names to ASCII without a network request.
	if strings.IndexFunc(host, func(char rune) bool { return char > 127 }) >= 0 {
		host, err = asciiHost(host)
		if err != nil {
			return "", err
		}
	}
	if address, parseErr := netip.ParseAddr(host); parseErr == nil {
		host = address.String()
	}
	port := u.Port()
	if port != "" {
		number, portErr := strconv.Atoi(port)
		if portErr != nil || number < 1 || number > 65535 {
			return "", fmt.Errorf("invalid server port")
		}
		port = strconv.Itoa(number)
	}
	if (u.Scheme == "https" && port == "443") || (u.Scheme == "http" && port == "80") {
		port = ""
	}
	if port != "" {
		host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	origin := url.URL{Scheme: strings.ToLower(u.Scheme), Host: host}
	return origin.String(), nil
}

func asciiHost(host string) (string, error) {
	request := &http.Request{Method: http.MethodGet, URL: &url.URL{Scheme: "https", Host: host, Path: "/"}}
	var wire bytes.Buffer
	if err := request.Write(&wire); err != nil {
		return "", err
	}
	parsed, err := http.ReadRequest(bufio.NewReader(&wire))
	if err != nil {
		return "", err
	}
	parsed.Body.Close()
	return parsed.Host, nil
}
