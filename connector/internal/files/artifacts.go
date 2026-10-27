package files

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
)

type ArtifactTransfer struct {
	Roots  map[string]string
	Client *http.Client
	Server string
}
type TransferInput struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	Root  string `json:"root"`
	Path  string `json:"path"`
}

func (a *ArtifactTransfer) Execute(ctx context.Context, method string, raw json.RawMessage) (any, error) {
	var input TransferInput
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, err
	}
	endpoint, err := url.Parse(input.URL)
	if err != nil {
		return nil, err
	}
	server, err := url.Parse(a.Server)
	if err != nil {
		return nil, err
	}
	if endpoint.Scheme != server.Scheme || endpoint.Host != server.Host || endpoint.User != nil {
		return nil, fmt.Errorf("transfer URL must use paired server origin")
	}
	root, ok := a.Roots[input.Root]
	if !ok {
		return nil, fmt.Errorf("artifact root %q is not configured", input.Root)
	}
	path, err := SafePath(root, input.Path)
	if err != nil {
		return nil, err
	}
	if method == "artifact.send" {
		return a.send(ctx, input, path)
	}
	return a.receive(ctx, input, path)
}
func (a *ArtifactTransfer) send(ctx context.Context, input TransferInput, path string) (any, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("source must be a regular file")
	}
	hash := sha256.New()
	if _, err = io.Copy(hash, file); err != nil {
		return nil, err
	}
	if _, err = file.Seek(0, 0); err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, input.URL, file)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+input.Token)
	request.Header.Set("X-Content-SHA256", hex.EncodeToString(hash.Sum(nil)))
	request.Header.Set("X-File-Name", url.PathEscape(filepath.Base(path)))
	request.ContentLength = info.Size()
	response, err := a.Client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("artifact upload HTTP %d", response.StatusCode)
	}
	var result map[string]any
	err = json.NewDecoder(response.Body).Decode(&result)
	return result, err
}
func (a *ArtifactTransfer) receive(ctx context.Context, input TransferInput, path string) (any, error) {
	if _, err := os.Lstat(path); err == nil {
		return nil, fmt.Errorf("destination already exists; preserving local file")
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, input.URL, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+input.Token)
	response, err := a.Client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("artifact download HTTP %d", response.StatusCode)
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".artifact-")
	if err != nil {
		return nil, err
	}
	defer os.Remove(temporary.Name())
	hash := sha256.New()
	size, copyErr := io.Copy(io.MultiWriter(temporary, hash), response.Body)
	closeErr := temporary.Close()
	if copyErr != nil {
		return nil, copyErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	checksum := hex.EncodeToString(hash.Sum(nil))
	if checksum != response.Header.Get("X-Content-SHA256") {
		return nil, fmt.Errorf("artifact SHA-256 mismatch")
	}
	// Hard-link publication fails if another writer creates the destination.
	if err = os.Link(temporary.Name(), path); err != nil {
		return nil, err
	}
	return map[string]any{"sha256": checksum, "size": size, "path": input.Path}, nil
}
