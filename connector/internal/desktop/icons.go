package desktop

import (
	"github.com/egoist/mygo/ui"
	"mcplatform/connector/internal/desktop/branding"
)

// One stroke grid keeps the small navigation and resource icons consistent.
var symbols = map[string]*ui.SVG{
	"connector": ui.MustParseSVG(branding.Mark()),
	"device":    lineIcon(`<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>`),
	"resources": lineIcon(`<rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01m4-11h4m-4 11h4"/>`),
	"skill":     lineIcon(`<path d="m12 3 2.6 5.5L21 9.5 16.5 14l1.1 6.4-5.6-3-5.6 3 1.1-6.4L3 9.5l6.4-1L12 3Z"/>`),
	"folder":    lineIcon(`<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>`),
	"history":   lineIcon(`<path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7m2-5v6l4 2"/>`),
	"settings":  lineIcon(`<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>`),
	"link":      lineIcon(`<path d="m10 13 4-4m-6 6-2 2a3.5 3.5 0 0 1-5-5l5-5a3.5 3.5 0 0 1 5 0m2 2 2-2a3.5 3.5 0 0 1 5 5l-5 5a3.5 3.5 0 0 1-5 0"/>`),
	"arrow":     lineIcon(`<path d="M5 12h14m-6-6 6 6-6 6"/>`),
	"refresh":   lineIcon(`<path d="M20 7v5h-5M4 17v-5h5m-4-4a8 8 0 0 1 13-3l2 2M4 17l2 2a8 8 0 0 0 13-3"/>`),
	"search":    lineIcon(`<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>`),
}

func lineIcon(paths string) *ui.SVG {
	return ui.MustParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">` + paths + `</svg>`))
}

func symbol(c *ui.Context, name string, size float32) ui.Element {
	return ui.Icon(c, symbols[name]).Size(size, size).Shrink(0)
}
