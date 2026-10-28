package agent

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestExecutionInterruptionIsUnknown(t *testing.T) {
	for _, err := range []error{context.DeadlineExceeded, fmt.Errorf("upstream: %w", context.Canceled)} {
		if got := executionError(context.Background(), err); got.Code != "RESULT_UNKNOWN" {
			t.Fatalf("%+v", got)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got := executionError(ctx, errors.New("transport closed")); got.Code != "RESULT_UNKNOWN" {
		t.Fatalf("%+v", got)
	}
	if got := executionError(context.Background(), errors.New("invalid input")); got.Code != "EXECUTION_FAILED" {
		t.Fatalf("%+v", got)
	}
}
