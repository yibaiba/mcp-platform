package local

import (
	"mcplatform/connector/internal/local/model"
	"testing"
)

func TestSubscribersCoexistWithPlatformAndRunOutsideLock(t *testing.T) {
	service, _ := fixture(t)
	platformCalls, desktopCalls := 0, 0
	service.SetNotifier(func() { platformCalls++; state(t, service, true) })
	unsubscribe := service.Subscribe(func() { desktopCalls++; state(t, service, false) })
	r := resource(t, service)
	if _, err := mutate(t, service, model.Request{Action: "select", ID: r.ID, Selected: true}); err != nil {
		t.Fatal(err)
	}
	if platformCalls != 1 || desktopCalls != 1 {
		t.Fatalf("platform=%d desktop=%d", platformCalls, desktopCalls)
	}
	service.SetNotifier(nil)
	if _, err := mutate(t, service, model.Request{Action: "select", ID: r.ID, Selected: false, OperationID: "second"}); err != nil {
		t.Fatal(err)
	}
	if platformCalls != 1 || desktopCalls != 2 {
		t.Fatalf("platform reconnect cleared desktop subscriber")
	}
	unsubscribe()
	unsubscribe()
	if _, err := mutate(t, service, model.Request{Action: "select", ID: r.ID, Selected: true, OperationID: "third"}); err != nil {
		t.Fatal(err)
	}
	if desktopCalls != 2 {
		t.Fatal("unsubscribed callback invoked")
	}
}

func TestOfflineInventoryBindsToOnlyOneDevice(t *testing.T) {
	service, _ := fixture(t)
	if err := service.BindTarget("device-one"); err != nil {
		t.Fatal(err)
	}
	if err := service.BindTarget("device-one"); err != nil {
		t.Fatal(err)
	}
	if err := service.BindTarget("device-two"); err == nil {
		t.Fatal("inventory reassigned")
	}
	if state(t, service, false).SyncTarget != "device-one" {
		t.Fatal("target changed on rejected binding")
	}
}
