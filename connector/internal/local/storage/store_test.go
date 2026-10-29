package storage

import (
	"mcplatform/connector/internal/local/documents"
	"mcplatform/connector/internal/local/model"
	"os"
	"path/filepath"
	"testing"
)

func TestRecoverReconcilesCommittedInterruptedAndExternalWrites(t *testing.T) {
	for _, tt := range []struct{ name, actual, want string }{{"committed", "after", "succeeded"}, {"before-write", "before", "interrupted"}, {"external", "external", "conflict"}} {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			target := filepath.Join(dir, "config.json")
			if err := os.WriteFile(target, []byte(tt.actual), 0600); err != nil {
				t.Fatal(err)
			}
			store := Store{Dir: filepath.Join(dir, "state")}
			state, err := store.Load()
			if err != nil {
				t.Fatal(err)
			}
			state.Operations["op"] = model.Operation{ID: "op", Phase: "prepared", Target: target, BeforeDigest: documents.Digest([]byte("before")), AfterDigest: documents.Digest([]byte("after"))}
			if err = store.Recover(&state); err != nil {
				t.Fatal(err)
			}
			if state.Operations["op"].Phase != tt.want {
				t.Fatal(state.Operations["op"])
			}
			actual, err := os.ReadFile(target)
			if err != nil || string(actual) != tt.actual {
				t.Fatal("recovery overwrote external state", err)
			}
		})
	}
}
func TestExclusiveStoreLease(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	first, err := store.Acquire()
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if second, err := store.Acquire(); err == nil {
		second.Close()
		t.Fatal("second writer was allowed")
	}
}
