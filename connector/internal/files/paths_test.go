package files

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPaths(t *testing.T) {
	root := t.TempDir()
	for _, path := range []string{"../outside", "/absolute", "C:/windows", "a\\b", "a/../b", "a//b"} {
		if _, err := SafePath(root, path); err == nil {
			t.Fatalf("accepted %q", path)
		}
	}
	if _, err := SafePath(root, "output/file.txt"); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if _, err := SafePath(root, "link/file"); err == nil {
		t.Fatal("accepted symlink")
	}
}
