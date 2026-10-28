package agent

import (
	"context"
	"errors"
)

func executionError(ctx context.Context, err error) *Error {
	// A connector deadline may win the race with the platform timer. Neither
	// cancellation nor a deadline proves that the upstream side effect did not run.
	if ctx.Err() != nil || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return &Error{Code: "RESULT_UNKNOWN", Message: "Device execution interrupted; verify the result before retrying"}
	}
	code := "EXECUTION_FAILED"
	var coded interface{ Code() string }
	if errors.As(err, &coded) {
		code = coded.Code()
	}
	return &Error{Code: code, Message: err.Error()}
}
