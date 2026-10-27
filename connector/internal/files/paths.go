package files

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func SafePath(root, relative string) (string, error) {
	if relative == "" || strings.ContainsAny(relative, "\\:\x00") || strings.HasPrefix(relative, "/") {
		return "", fmt.Errorf("invalid relative path")
	}
	for _, part := range strings.Split(relative, "/") {
		if part == "" || part == "." || part == ".." {
			return "", fmt.Errorf("invalid path segment")
		}
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	ancestor := absolute
	for {
		_, err = os.Stat(ancestor)
		if err == nil {
			break
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		ancestor = filepath.Dir(ancestor)
	}
	canonical, err := filepath.EvalSymlinks(ancestor)
	if err != nil {
		return "", err
	}
	suffix, err := filepath.Rel(ancestor, absolute)
	if err != nil {
		return "", err
	}
	absolute = filepath.Join(canonical, suffix)
	target := filepath.Join(absolute, filepath.FromSlash(relative))
	for current := target; current != absolute; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil && !os.IsNotExist(err) {
			return "", err
		}
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("symlinks are not allowed: %s", current)
		}
	}
	return target, nil
}
