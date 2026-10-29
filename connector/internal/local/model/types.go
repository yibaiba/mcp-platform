package model

import "encoding/json"

type Source struct {
	ID       string   `json:"id"`
	Client   string   `json:"client"`
	Kind     string   `json:"kind"`
	Path     string   `json:"path"`
	Format   string   `json:"format"`
	Project  string   `json:"project,omitempty"`
	Pointer  []string `json:"pointer,omitempty"`
	ReadOnly bool     `json:"readOnly"`
}

type Resource struct {
	ID             string          `json:"id"`
	Kind           string          `json:"kind"`
	Name           string          `json:"name"`
	Description    string          `json:"description"`
	SourceIDs      []string        `json:"sourceIds"`
	Clients        []string        `json:"clients"`
	Project        string          `json:"project,omitempty"`
	Path           string          `json:"path"`
	RealPath       string          `json:"realPath"`
	Pointer        []string        `json:"pointer,omitempty"`
	Digest         string          `json:"digest"`
	FileDigest     string          `json:"fileDigest"`
	Content        json.RawMessage `json:"content"`
	ReadOnly       bool            `json:"readOnly"`
	Deleted        bool            `json:"deleted"`
	Selected       bool            `json:"selected"`
	ReloadRequired bool            `json:"reloadRequired"`
	LoadedVerified bool            `json:"loadedVerified"`
	ProgramExists  bool            `json:"programExists"`
	Runtime        string          `json:"runtime"`
	Issues         []string        `json:"issues"`
}

type Operation struct {
	ID            string          `json:"id"`
	Action        string          `json:"action"`
	ResourceID    string          `json:"resourceId,omitempty"`
	RequestDigest string          `json:"requestDigest"`
	Phase         string          `json:"phase"`
	Error         string          `json:"error,omitempty"`
	CreatedAt     string          `json:"createdAt"`
	Result        json.RawMessage `json:"result,omitempty"`
	Backup        string          `json:"backup,omitempty"`
	BeforeDigest  string          `json:"beforeDigest,omitempty"`
	AfterDigest   string          `json:"afterDigest,omitempty"`
	Target        string          `json:"target,omitempty"`
	Staged        string          `json:"staged,omitempty"`
}

type State struct {
	SyncTarget        string               `json:"syncTarget,omitempty"`
	Initialized       bool                 `json:"initialized"`
	IdentityResources map[string]string    `json:"identityResources"`
	Revision          int                  `json:"revision"`
	Sources           []Source             `json:"sources"`
	Resources         map[string]Resource  `json:"resources"`
	Operations        map[string]Operation `json:"operations"`
	Issues            []string             `json:"issues"`
}

type Request struct {
	Identity         string          `json:"identity,omitempty"`
	Action           string          `json:"action"`
	ID               string          `json:"id,omitempty"`
	OperationID      string          `json:"operationId,omitempty"`
	ExpectedRevision int             `json:"expectedRevision,omitempty"`
	ExpectedDigest   string          `json:"expectedDigest,omitempty"`
	Content          json.RawMessage `json:"content,omitempty"`
	Source           *Source         `json:"source,omitempty"`
	Project          string          `json:"project,omitempty"`
	Confirm          bool            `json:"confirm,omitempty"`
	Selected         bool            `json:"selected,omitempty"`
}
