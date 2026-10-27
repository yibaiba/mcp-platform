package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/config"
	"net/http"
	"strings"
)

func Pair(ctx context.Context, client *http.Client, server, code string) (config.Config, error) {
	result := config.Config{Server: strings.TrimRight(server, "/"), SkillRoots: map[string]string{}, ArtifactRoots: map[string]string{}}
	if _, err := config.ValidateServer(server); err != nil {
		return result, err
	}
	body, err := json.Marshal(map[string]string{"code": code})
	if err != nil {
		return result, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, result.Server+"/api/v1/devices/pair", bytes.NewReader(body))
	if err != nil {
		return result, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return result, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		return result, fmt.Errorf("pairing failed: HTTP %d", response.StatusCode)
	}
	err = json.NewDecoder(response.Body).Decode(&result)
	return result, err
}
