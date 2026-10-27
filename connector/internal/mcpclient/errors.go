package mcpclient

import "fmt"

// A call error after dispatch cannot prove that the tool had no side effects.
type DeliveryError struct{ Cause error }

func (e *DeliveryError) Error() string {
	return fmt.Sprintf("tool request failed after dispatch; execution result unknown: %v", e.Cause)
}
func (e *DeliveryError) Unwrap() error { return e.Cause }
func (e *DeliveryError) Code() string  { return "RESULT_UNKNOWN" }
