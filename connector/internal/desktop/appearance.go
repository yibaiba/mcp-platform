package desktop

import "github.com/egoist/mygo/ui"

type appearance struct {
	Canvas, Sidebar, Panel, Input, Border, Hover ui.Color
	Text, Muted, Accent, Selected, SelectedText  ui.Color
}

func colors(c *ui.Context) appearance {
	if c.Theme().Dark {
		return appearance{Canvas: ui.Hex("#171b21"), Sidebar: ui.Hex("#1e232b"), Panel: ui.Hex("#222831"),
			Input: ui.Hex("#1c222a"), Border: ui.Hex("#343d49"), Hover: ui.Hex("#2b333f"), Text: ui.Hex("#edf1f7"), Muted: ui.Hex("#a6afbd"),
			Accent: ui.Hex("#70a7ff"), Selected: ui.Hex("#283c58"), SelectedText: ui.Hex("#b3d1ff")}
	}
	return appearance{Canvas: ui.Hex("#f8f9fb"), Sidebar: ui.Hex("#eff2f6"), Panel: ui.Hex("#ffffff"),
		Input: ui.Hex("#ffffff"), Border: ui.Hex("#e0e5ed"), Hover: ui.Hex("#e7ecf3"), Text: ui.Hex("#202a38"), Muted: ui.Hex("#697586"),
		Accent: ui.Hex("#2864d7"), Selected: ui.Hex("#dfe9f9"), SelectedText: ui.Hex("#2457a3")}
}

func setAppearance(c *ui.Context) {
	p := colors(c)
	theme := *c.Theme()
	theme.Background, theme.Text, theme.TextMuted = p.Canvas, p.Text, p.Muted
	theme.Surface, theme.Border, theme.Radius, theme.FontSize = p.Input, p.Border, 7, 14
	theme.SurfaceHover, theme.SurfacePressed = p.Hover, p.Border
	c.SetTheme(&theme)
}

func panel(c *ui.Context) ui.Element {
	p := colors(c)
	return ui.Column(c).FillWidth().Padding(24).Gap(16).Background(p.Panel).Border(1, p.Border).Radius(14)
}

func sectionTitle(c *ui.Context, title, description string) {
	ui.Column(c).Gap(6).Children(func() {
		ui.Text(c, title).FontSize(16).FontWeight(600)
		if description != "" {
			ui.Text(c, description).FontSize(13).TextColor(colors(c).Muted)
		}
	})
}

func quietButton(c *ui.Context, label string) ui.Element {
	return ui.Button(c, label).Border(0, ui.Transparent).Background(ui.Transparent).Height(32).Radius(6).TextColor(colors(c).Muted)
}

func statusDot(c *ui.Context, color ui.Color) {
	ui.Box(c).Size(7, 7).Radius(4).Background(color).Shrink(0)
}

type emptyState struct{ Icon, Title, Description string }

func emptyView(c *ui.Context, state emptyState) {
	ui.Column(c).Grow(1).FillWidth().Center().Gap(12).Padding(24).Children(func() {
		ui.Box(c).Size(56, 56).Radius(16).Background(colors(c).Canvas).Border(1, colors(c).Border).Center().Children(func() {
			symbol(c, state.Icon, 24).TextColor(colors(c).Muted)
		})
		ui.Text(c, state.Title).FontSize(15).FontWeight(600)
		ui.Text(c, state.Description).FontSize(13).TextColor(colors(c).Muted).MaxWidth(340).TextAlign(ui.Center)
	})
}
