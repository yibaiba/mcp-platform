package agent

import "testing"

func TestProtocol(t *testing.T) {
	valid := `{"v":1,"type":"request","id":"6ea64e51-caf5-4c0d-8e7e-74052d2fd39d","method":"discover","deadline":"2026-10-26T09:00:00Z","params":{}}`
	if _, err := Decode([]byte(valid)); err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{`{"v":2,"type":"request","id":"id"}`, `{"v":1,"type":"request","id":"id"}`, `{"v":1,"type":"cancel"}`} {
		if _, err := Decode([]byte(input)); err == nil {
			t.Fatal("accepted invalid protocol", input)
		}
	}
}
