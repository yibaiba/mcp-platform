// Package branding contains the artwork shared by the UI and native shell.
// Regenerate the PNG, ICNS and composed SVG files with go run ./scripts/icons
// from the connector directory. mark.svg is the source of the symbol geometry.
package branding

import _ "embed"

//go:embed mark.svg
var mark []byte

//go:embed connector.png
var application []byte

//go:embed tray.png
var tray []byte

//go:embed tray-template.png
var templateTray []byte

// Asset bytes are immutable; callers must not modify the returned slices.
func Mark() []byte { return mark }

func Application() []byte { return application }

func Tray(template bool) []byte {
	if template {
		return templateTray
	}
	return tray
}
