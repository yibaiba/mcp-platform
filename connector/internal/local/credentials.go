package local

import (
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/local/documents"
	"mcplatform/connector/internal/local/model"
	"mcplatform/connector/internal/mcpclient"
	"strings"
)

func reference(id string, path []string) string { return "local://" + id + documents.Pointer(path) }
func publicString(path []string) bool {
	return len(path) == 1 && (path[0] == "type" || path[0] == "transport" || path[0] == "description")
}
func transform(value any, path []string, visit func(string, []string) (string, error)) (any, error) {
	switch v := value.(type) {
	case string:
		return visit(v, path)
	case []any:
		result := make([]any, len(v))
		for i, item := range v {
			mapped, err := transform(item, append(append([]string{}, path...), fmt.Sprint(i)), visit)
			if err != nil {
				return nil, err
			}
			result[i] = mapped
		}
		return result, nil
	case map[string]any:
		result := map[string]any{}
		for key, item := range v {
			mapped, err := transform(item, append(append([]string{}, path...), key), visit)
			if err != nil {
				return nil, err
			}
			result[key] = mapped
		}
		return result, nil
	default:
		return value, nil
	}
}
func Redact(resource model.Resource) model.Resource {
	if resource.Kind != "mcp" {
		if !resource.Selected {
			resource.Content = nil
		}
		return resource
	}
	var content any
	if _, err := documents.Object(resource.Content); err != nil {
		resource.Content = nil
		return resource
	}
	if json.Unmarshal(resource.Content, &content) != nil {
		resource.Content = nil
		return resource
	}
	value, _ := transform(content, nil, func(value string, path []string) (string, error) {
		if publicString(path) {
			return value, nil
		}
		return reference(resource.ID, path), nil
	})
	resource.Content = documents.Encode(value)
	return resource
}
func hydrate(resource model.Resource, content json.RawMessage) (json.RawMessage, error) {
	var current, next any
	if json.Unmarshal(resource.Content, &current) != nil || json.Unmarshal(content, &next) != nil {
		return nil, fmt.Errorf("invalid resource content")
	}
	secrets := map[string]string{}
	_, err := transform(current, nil, func(value string, path []string) (string, error) {
		if !publicString(path) {
			secrets[reference(resource.ID, path)] = value
		}
		return value, nil
	})
	if err != nil {
		return nil, err
	}
	value, err := transform(next, nil, func(value string, path []string) (string, error) {
		if publicString(path) {
			return value, nil
		}
		if value != reference(resource.ID, path) {
			return "", fmt.Errorf("credential-bearing field must be edited in the local page")
		}
		raw, ok := secrets[value]
		if !ok {
			return "", fmt.Errorf("local credential reference is unavailable")
		}
		return raw, nil
	})
	if err != nil {
		return nil, err
	}
	return documents.Encode(value), nil
}

// Resolve reads the selected device resource at dispatch time. Independent identities
// must provide an explicit local binding; they never inherit the client's account.
func (s *Service) Resolve(raw json.RawMessage) (json.RawMessage, error) {
	var input struct {
		Config struct {
			DeviceResourceID     string `json:"deviceResourceId"`
			DeviceResourceDigest string `json:"deviceResourceDigest"`
			LocalIdentity        string `json:"localIdentity"`
		} `json:"config"`
	}
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, err
	}
	if input.Config.DeviceResourceID == "" {
		return raw, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.scan(s.ctx)
	resourceID := input.Config.DeviceResourceID
	if _, err := s.selectedResource(resourceID); err != nil {
		return nil, err
	}
	if input.Config.LocalIdentity != "" && input.Config.LocalIdentity != "default" {
		var ok bool
		resourceID, ok = s.state.IdentityResources[input.Config.LocalIdentity]
		if !ok {
			return nil, fmt.Errorf("IDENTITY_CREDENTIAL_REQUIRED: configure a dedicated local binding; shared client credentials are not used")
		}
	}
	r, err := s.selectedResource(resourceID)
	if err != nil {
		return nil, err
	}
	if input.Config.LocalIdentity == "default" && input.Config.DeviceResourceDigest != "" && input.Config.DeviceResourceDigest != r.Digest {
		return nil, fmt.Errorf("LOCAL_RESOURCE_CHANGED: synchronize configuration before dispatch")
	}
	source, err := s.source(r)
	if err != nil {
		return nil, err
	}
	config, err := s.resourceRuntime(r, source)
	if err != nil {
		return nil, err
	}
	var params map[string]json.RawMessage
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, err
	}
	// Forward only explicit transport-level additions; no platform config may replace local process settings.
	var envelope struct {
		Config mcpclient.Config `json:"config"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}
	if config.Headers == nil {
		config.Headers = map[string]string{}
	}
	for key, value := range envelope.Config.Headers {
		if strings.EqualFold(key, "authorization") || strings.EqualFold(key, "cookie") {
			return nil, fmt.Errorf("device credentials must be edited locally")
		}
		config.Headers[key] = value
	}
	config.DeviceSourceID = input.Config.DeviceResourceID
	config.DeviceResourceID = r.ID
	config.DeviceResourceDigest = r.Digest
	params["config"] = documents.Encode(config)
	return json.Marshal(params)
}

func (s *Service) selectedResource(id string) (model.Resource, error) {
	r, ok := s.state.Resources[id]
	if !ok || !r.Selected || r.Deleted || r.Kind != "mcp" {
		return model.Resource{}, fmt.Errorf("selected device resource is unavailable")
	}
	if len(r.Issues) > 0 {
		return model.Resource{}, fmt.Errorf("LOCAL_RESOURCE_INVALID: fix the local source errors before dispatch")
	}
	return r, nil
}
