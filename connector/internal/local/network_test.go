package local

import (
	"context"
	"mcplatform/connector/internal/local/model"
	"testing"
)

func TestRemoteCannotReadWriteOrCheckDeviceNetwork(t *testing.T) {
	service := &Service{}
	for _, action := range []string{"network.get", "network.save", "network.check"} {
		if _, err := service.networkRequest(context.Background(), model.Request{Action: action}, true); err == nil {
			t.Fatalf("remote %s succeeded", action)
		}
	}
}
