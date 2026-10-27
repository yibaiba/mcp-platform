package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"time"
)

var correlationID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

const Version = "0.1.0"
const HeartbeatInterval = 15 * time.Second
const ReconnectDelay = 3 * time.Second

type Message struct {
	V        int             `json:"v"`
	Type     string          `json:"type"`
	ID       string          `json:"id"`
	Method   string          `json:"method,omitempty"`
	Deadline time.Time       `json:"deadline,omitempty"`
	Params   json.RawMessage `json:"params,omitempty"`
}

func Decode(data []byte) (Message, error) {
	var m Message
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&m); err != nil {
		return m, err
	}
	if m.V != 1 || (m.Type != "request" && m.Type != "cancel") || m.ID == "" {
		return m, fmt.Errorf("invalid device protocol envelope")
	}
	if !correlationID.MatchString(m.ID) {
		return m, fmt.Errorf("invalid correlation UUID")
	}
	if m.Type == "request" && (m.Deadline.IsZero() || len(m.Params) == 0) {
		return m, fmt.Errorf("request requires deadline and params")
	}
	return m, nil
}

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type Result struct {
	V      int    `json:"v"`
	Type   string `json:"type"`
	ID     string `json:"id"`
	Result any    `json:"result,omitempty"`
	Error  *Error `json:"error,omitempty"`
}
