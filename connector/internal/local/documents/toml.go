package documents

import (
	"bytes"
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"github.com/pelletier/go-toml/v2"
	"github.com/pelletier/go-toml/v2/unstable"
)

type span struct {
	start, end int
	text       string
}
type assignment struct {
	path              []string
	start, end, value int
}
type section struct {
	path       []string
	start, end int
}

func keys(n *unstable.Node) []string {
	var result []string
	iter := n.Key()
	for iter.Next() {
		result = append(result, string(iter.Node().Data))
	}
	return result
}
func prefix(path, parent []string) bool {
	return len(path) >= len(parent) && reflect.DeepEqual(path[:len(parent)], parent)
}
func syntax(data []byte) ([]assignment, []section, error) {
	var parser unstable.Parser
	parser.Reset(data)
	assignments := []assignment{}
	sections := []section{{nil, 0, 0}}
	var current []string
	for parser.NextExpression() {
		n := parser.Expression()
		if n.Kind == unstable.Table || n.Kind == unstable.ArrayTable {
			current = keys(n)
			first := n.Key()
			first.Next()
			start := int(first.Node().Raw.Offset)
			start = bytes.LastIndexByte(data[:start], '\n') + 1
			end := bytes.IndexByte(data[start:], '\n')
			if end < 0 {
				end = len(data) - start
			} else {
				end++
			}
			sections = append(sections, section{current, start, start + end})
			continue
		}
		if n.Kind != unstable.KeyValue {
			continue
		}
		path := append(append([]string{}, current...), keys(n)...)
		start, end := int(n.Raw.Offset), int(n.Raw.Offset+n.Raw.Length)
		iter := n.Key()
		var last *unstable.Node
		for iter.Next() {
			last = iter.Node()
		}
		value := int(last.Raw.Offset + last.Raw.Length)
		value += bytes.IndexByte(data[value:end], '=') + 1
		for value < end && (data[value] == ' ' || data[value] == '\t') {
			value++
		}
		assignments = append(assignments, assignment{path, start, end, value})
	}
	return assignments, sections, parser.Error()
}
func tomlValue(value any) (string, error) {
	encoded, err := toml.Marshal(map[string]any{"value": value})
	if err != nil {
		return "", fmt.Errorf("unsupported TOML value")
	}
	// Marshal may produce tables. Inline JSON-like maps must use TOML inline table syntax.
	if object, ok := value.(map[string]any); ok {
		parts := []string{}
		names := make([]string, 0, len(object))
		for key := range object {
			names = append(names, key)
		}
		sort.Strings(names)
		for _, key := range names {
			text, err := tomlValue(object[key])
			if err != nil {
				return "", err
			}
			parts = append(parts, strconv.Quote(key)+" = "+text)
		}
		return "{ " + strings.Join(parts, ", ") + " }", nil
	}
	if values, ok := value.([]any); ok {
		parts := []string{}
		for _, v := range values {
			text, err := tomlValue(v)
			if err != nil {
				return "", err
			}
			parts = append(parts, text)
		}
		return "[" + strings.Join(parts, ", ") + "]", nil
	}
	return strings.TrimSpace(strings.TrimPrefix(string(encoded), "value = ")), nil
}
func quoted(path []string) string {
	parts := make([]string, len(path))
	for i, k := range path {
		parts[i] = strconv.Quote(k)
	}
	return strings.Join(parts, ".")
}
func editTOML(data []byte, path []string, before, after any) ([]byte, error) {
	assignments, sections, err := syntax(data)
	if err != nil {
		return nil, err
	}
	patches := []span{}
	covered := [][]string{}
	for _, a := range assignments {
		if !prefix(a.path, path) {
			continue
		}
		old, _ := AtValue(before, a.path[len(path):])
		next, exists := AtValue(after, a.path[len(path):])
		covered = append(covered, a.path)
		if exists && reflect.DeepEqual(old, next) {
			continue
		}
		if !exists {
			patches = append(patches, span{a.start, a.end, ""})
			continue
		}
		text, err := tomlValue(next)
		if err != nil {
			return nil, err
		}
		patches = append(patches, span{a.value, a.end, text})
	}
	if after == nil {
		for _, s := range sections {
			if prefix(s.path, path) {
				patches = append(patches, span{s.start, s.end, ""})
			}
		}
	}
	for _, c := range changes(path, before, after) {
		if after == nil || c.op == "remove" {
			continue
		}
		found := false
		for _, p := range covered {
			if prefix(c.path, p) {
				found = true
				break
			}
		}
		if found {
			continue
		}
		text, err := tomlValue(c.value)
		if err != nil {
			return nil, err
		}
		best := sections[0]
		for _, s := range sections {
			if prefix(c.path, s.path) && len(s.path) > len(best.path) {
				best = s
			}
		}
		patches = append(patches, span{best.end, best.end, quoted(c.path[len(best.path):]) + " = " + text + "\n"})
	}
	sort.SliceStable(patches, func(i, j int) bool { return patches[i].start > patches[j].start })
	for _, p := range patches {
		data = append(append(append([]byte{}, data[:p.start]...), []byte(p.text)...), data[p.end:]...)
	}
	root, err := Parse(data, "toml")
	if err != nil {
		return nil, err
	}
	actual, exists := At(root, path)
	if (after == nil && exists) || (after != nil && !reflect.DeepEqual(actual, after)) {
		return nil, fmt.Errorf("TOML edit cannot preserve this configuration's semantics")
	}
	return data, nil
}
func AtValue(value any, path []string) (any, bool) {
	if len(path) == 0 {
		return value, value != nil
	}
	root, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	return At(root, path)
}
