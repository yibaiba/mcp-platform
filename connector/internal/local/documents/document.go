package documents

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"

	"github.com/pelletier/go-toml/v2"
	"github.com/tailscale/hujson"
)

func Digest(data []byte) string        { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func Encode(value any) json.RawMessage { data, _ := json.Marshal(value); return data }
func Pointer(parts []string) string {
	var result string
	for _, part := range parts {
		result += "/" + strings.ReplaceAll(strings.ReplaceAll(part, "~", "~0"), "/", "~1")
	}
	return result
}
func Parse(data []byte, format string) (map[string]any, error) {
	result := map[string]any{}
	if format == "toml" {
		if err := toml.Unmarshal(data, &result); err != nil {
			return nil, fmt.Errorf("invalid TOML configuration")
		}
		// Normalize integer types for JSON-compatible comparisons.
		data = Encode(result)
	} else {
		value, err := hujson.Parse(bytes.Clone(data))
		if err != nil {
			return nil, fmt.Errorf("invalid JSON/JSONC configuration")
		}
		value.Standardize()
		data = value.Pack()
	}
	if err := json.Unmarshal(data, &result); err != nil || result == nil {
		return nil, fmt.Errorf("configuration must be an object")
	}
	return result, nil
}
func At(root map[string]any, path []string) (any, bool) {
	var current any = root
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = object[key]
		if !ok {
			return nil, false
		}
	}
	return current, true
}

type change struct {
	op    string
	path  []string
	value any
}

func changes(path []string, before, after any) []change {
	if reflect.DeepEqual(before, after) {
		return nil
	}
	old, oldOK := before.(map[string]any)
	next, nextOK := after.(map[string]any)
	if !oldOK || !nextOK {
		return []change{{"replace", path, after}}
	}
	var result []change
	for key, value := range old {
		child := append(append([]string{}, path...), key)
		if replacement, ok := next[key]; ok {
			result = append(result, changes(child, value, replacement)...)
		} else {
			result = append(result, change{"remove", child, nil})
		}
	}
	for key, value := range next {
		if _, ok := old[key]; !ok {
			result = append(result, change{"add", append(append([]string{}, path...), key), value})
		}
	}
	return result
}

func Edit(data []byte, format string, path []string, after any) ([]byte, error) {
	root, err := Parse(data, format)
	if err != nil {
		return nil, err
	}
	before, exists := At(root, path)
	if !exists {
		return nil, fmt.Errorf("selected configuration entry no longer exists")
	}
	if format == "toml" {
		return editTOML(data, path, before, after)
	}
	value, err := hujson.Parse(data)
	if err != nil {
		return nil, fmt.Errorf("invalid JSON configuration")
	}
	patches := []map[string]any{}
	list := changes(path, before, after)
	if after == nil {
		list = []change{{"remove", path, nil}}
	}
	for _, c := range list {
		patches = append(patches, map[string]any{"op": c.op, "path": Pointer(c.path), "value": c.value})
	}
	if err := value.Patch(Encode(patches)); err != nil {
		return nil, fmt.Errorf("configuration patch failed")
	}
	output := value.Pack()
	updated, err := Parse(output, format)
	if err != nil {
		return nil, err
	}
	actual, exists := At(updated, path)
	if (after == nil && exists) || (after != nil && (!exists || !reflect.DeepEqual(actual, after))) {
		return nil, fmt.Errorf("configuration edit could not preserve selected entry semantics")
	}
	return output, nil
}
func Equal(a, b json.RawMessage) bool {
	var left, right any
	return json.Unmarshal(a, &left) == nil && json.Unmarshal(b, &right) == nil && reflect.DeepEqual(left, right)
}
func Object(data json.RawMessage) (map[string]any, error) {
	var result map[string]any
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&result); err != nil || result == nil {
		return nil, fmt.Errorf("content must be a JSON object")
	}
	return result, nil
}

func Insert(data []byte, format string, path []string, value any) ([]byte, error) {
	root, err := Parse(data, format)
	if err != nil {
		return nil, err
	}
	if _, exists := At(root, path); exists {
		return nil, fmt.Errorf("entry already exists")
	}
	if format == "toml" {
		return editTOML(data, path, map[string]any{}, value)
	}
	parsed, err := hujson.Parse(data)
	if err != nil {
		return nil, err
	}
	insertPath := path
	insertValue := value
	for i := range path {
		if _, exists := At(root, path[:i+1]); exists {
			continue
		}
		insertPath = path[:i+1]
		for j := len(path) - 1; j > i; j-- {
			insertValue = map[string]any{path[j]: insertValue}
		}
		break
	}
	if err = parsed.Patch(Encode([]map[string]any{{"op": "add", "path": Pointer(insertPath), "value": insertValue}})); err != nil {
		return nil, fmt.Errorf("cannot restore entry into changed configuration")
	}
	return parsed.Pack(), nil
}
