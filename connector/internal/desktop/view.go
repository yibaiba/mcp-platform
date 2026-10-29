package desktop

import (
	"crypto/rand"
	"fmt"
	"github.com/egoist/mygo/ui"
)

func operationID() string {
	var id [16]byte
	rand.Read(id[:])
	id[6] = id[6]&0x0f | 0x40
	id[8] = id[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
}

func connectionLabel(phase string) string {
	switch phase {
	case "connected":
		return "已连接"
	case "connecting":
		return "连接中"
	case "reconnecting":
		return "等待重新连接"
	default:
		return "未连接"
	}
}

func (a *App) view(c *ui.Context) {
	setAppearance(c)
	ui.Column(c).Fill().Children(func() {
		ui.Row(c).Grow(1).MinHeight(0).Children(func() {
			a.navigation(c)
			ui.Column(c).Grow(1).MinWidth(0).FillHeight().Padding(24, 28).Gap(20).Children(func() {
				a.pageHeading(c)
				a.pageContent(c)
			})
		})
		a.feedback(c)
	})
}

func (a *App) pageHeading(c *ui.Context) {
	descriptions := map[string]string{
		"设备连接": "将这台电脑接入你的工作空间。", "MCP": "本机的工具与服务", "Skills": "本机的技能与文件",
		"扫描来源": "管理资源发现的位置", "操作记录": "最近的修改与同步", "设置": "配置你的桌面连接器",
	}
	ui.Row(c).FillWidth().Gap(16).Children(func() {
		ui.Column(c).Grow(1).Gap(5).Children(func() {
			ui.Text(c, a.page).FontSize(22).FontWeight(600)
			ui.Text(c, descriptions[a.page]).FontSize(12).TextColor(colors(c).Muted)
		})
		ui.Row(c).Gap(7).Padding(7, 10).Radius(8).Background(colors(c).Panel).Border(1, colors(c).Border).Children(func() {
			color := colors(c).Muted
			if a.connection.Phase == "connected" {
				color = c.Theme().Success
			}
			statusDot(c, color)
			ui.Text(c, connectionLabel(a.connection.Phase)).FontSize(12).TextColor(colors(c).Muted)
		})
	})
}

func (a *App) navigation(c *ui.Context) {
	p := colors(c)
	ui.Column(c).Width(196).FillHeight().Padding(24, 12, 16, 12).Gap(4).Background(p.Sidebar).Border(1, p.Border).BorderWidth(0, 1, 0, 0).Children(func() {
		ui.Row(c).Padding(0, 10, 28, 10).Gap(10).Children(func() {
			ui.Box(c).Size(32, 32).Radius(9).Background(c.Theme().Accent).Center().Children(func() { symbol(c, "connector", 20).TextColor(c.Theme().AccentText) })
			ui.Column(c).Gap(3).Children(func() {
				ui.Text(c, "MCP Platform").FontSize(13).FontWeight(600)
				ui.Text(c, "Connector").FontSize(11).TextColor(p.Muted)
			})
		})
		a.navigationItem(c, navigationEntry{Label: "设备连接", Icon: "device"})
		navigationLabel(c, "资源库")
		a.navigationItem(c, navigationEntry{Label: "MCP", Icon: "resources", Kind: "mcp"})
		a.navigationItem(c, navigationEntry{Label: "Skills", Icon: "skill", Kind: "skill"})
		navigationLabel(c, "管理")
		a.navigationItem(c, navigationEntry{Label: "扫描来源", Icon: "folder"})
		a.navigationItem(c, navigationEntry{Label: "操作记录", Icon: "history"})
		ui.Spacer(c)
		a.navigationItem(c, navigationEntry{Label: "设置", Icon: "settings"})
		ui.Column(c).Margin(12, 8, 0, 8).Gap(14).Children(func() {
			ui.Divider(c)
			ui.Row(c).Gap(10).Children(func() {
				ui.Box(c).Size(30, 30).Background(p.Panel).Border(1, p.Border).Radius(8).Center().Children(func() { symbol(c, "device", 16).TextColor(p.Muted) })
				ui.Column(c).Gap(4).Children(func() {
					ui.Text(c, "此电脑").FontSize(12).FontWeight(500)
					label := "正在读取资源"
					if a.ready {
						label = "本机管理可用"
					}
					ui.Text(c, label).FontSize(11).TextColor(p.Muted)
				})
			})
		})
	})
}

func navigationLabel(c *ui.Context, label string) {
	ui.Text(c, label).FontSize(11).FontWeight(500).TextColor(colors(c).Muted).Padding(20, 12, 8, 12)
}

type navigationEntry struct{ Label, Icon, Kind string }

func (a *App) navigationItem(c *ui.Context, item navigationEntry) {
	p := colors(c)
	button := ui.ButtonBase(c.Key(item.Label)).Label(item.Label).FillWidth().Height(36).Padding(8, 12).Gap(10).Justify(ui.Start).Radius(7).Disabled(a.closing)
	ink := p.Muted
	if button.Hovered() || button.Pressed() {
		button.Background(p.Hover)
	}
	if a.page == item.Label {
		button.Background(p.Selected)
		ink = p.SelectedText
	}
	if button.FocusVisible() {
		button.Border(1, c.Theme().Focus)
	}
	button.TextColor(ink).Children(func() {
		symbol(c, item.Icon, 16)
		ui.Text(c, item.Label).FontSize(13).FontWeight(500)
		if item.Kind != "" && a.ready {
			ui.Spacer(c)
			ui.Text(c, fmt.Sprint(a.resourceCount(item.Kind))).FontSize(11).TextColor(ink)
		}
	})
	if button.Clicked() {
		a.page = item.Label
	}
}

func (a *App) pageContent(c *ui.Context) {
	switch a.page {
	case "设备连接":
		a.connectionView(c)
	case "MCP":
		a.resourcesView(c, "mcp")
	case "Skills":
		a.resourcesView(c, "skill")
	case "扫描来源":
		a.sourcesView(c)
	case "操作记录":
		a.historyView(c)
	case "设置":
		a.settingsView(c)
	}
}

func (a *App) feedback(c *ui.Context) {
	if a.error == "" && a.notice == "" {
		return
	}
	ui.Column(c).FillWidth().Padding(10, 24).Gap(6).Background(colors(c).Panel).Children(func() {
		if a.error != "" {
			ui.TextArea(c.Key("error"), &a.error).ReadOnly(true).Height(64).Label("操作错误").TextColor(c.Theme().Danger)
		}
		if a.notice != "" {
			ui.Text(c, a.notice).FontSize(12).TextColor(colors(c).Muted)
		}
	})
}

func field(c *ui.Context, label string, value *string) {
	ui.Field(c.Key(label), label, func() {
		ui.TextInput(c, value).FillWidth().Height(36).Padding(8, 11).Background(colors(c).Input)
	}).FontSize(13)
}
