package desktop

import (
	"fmt"
	"github.com/egoist/mygo/ui"
)

func (a *App) connectionView(c *ui.Context) {
	ui.Scroll(c).Grow(1).FillWidth().Children(func() {
		ui.Column(c).FillWidth().AlignItems(ui.Center).Children(func() {
			ui.Column(c).FillWidth().MaxWidth(640).Padding(12, 0, 20, 0).Gap(24).Children(func() {
				a.connectionSummary(c)
				if a.deviceID == "" {
					a.pairingPanel(c)
				} else {
					panel(c).Children(func() {
						ui.Collapsible(c, "重新配对设备", &a.repairOpen, func() { a.pairingFields(c) })
					})
				}
				ui.Column(c).Gap(12).Children(func() {
					ui.Text(c, "本机资源").FontSize(12).FontWeight(500).TextColor(colors(c).Muted)
					ui.Row(c).Gap(16).Children(func() {
						a.inventoryMetric(c, inventoryLabel{Label: "MCP 服务", Kind: "mcp", Icon: "resources", Page: "MCP"})
						a.inventoryMetric(c, inventoryLabel{Label: "Skills", Kind: "skill", Icon: "skill", Page: "Skills"})
					})
				})
			})
		})
	})
}

func (a *App) connectionSummary(c *ui.Context) {
	ui.Column(c).Gap(16).Padding(4, 4, 0, 4).Children(func() {
		ui.Row(c).Gap(20).Children(func() {
			ui.Box(c).Size(64, 64).Radius(18).Background(colors(c).Panel).Border(1, colors(c).Border).Shadow(0, 3, 8, -3, colors(c).Text.Alpha(0.08)).Center().Children(func() {
				symbol(c, "device", 30).TextColor(colors(c).Accent)
			})
			ui.Column(c).Grow(1).Gap(8).Children(func() {
				title, description := "连接你的工作空间", "让本机的工具与技能，在平台中随时可用。"
				if a.deviceID != "" {
					title, description = connectionLabel(a.connection.Phase), "设备 ID："+a.deviceID
				}
				ui.Text(c, title).FontSize(26).FontWeight(600)
				ui.Text(c, description).FontSize(13).TextColor(colors(c).Muted)
			})
			if a.deviceID != "" {
				a.connectionControls(c)
			}
		})
		if a.connection.Error != "" {
			ui.Text(c, a.connection.Error).FontSize(13).TextColor(c.Theme().Danger)
		}
	})
}

type inventoryLabel struct{ Label, Kind, Icon, Page string }

func (a *App) resourceCount(kind string) int {
	count := 0
	for _, resource := range a.state.Resources {
		if resource.Kind == kind && !resource.Deleted {
			count++
		}
	}
	return count
}

func (a *App) inventoryMetric(c *ui.Context, metric inventoryLabel) {
	p := colors(c)
	button := ui.ButtonBase(c.Key("inventory-"+metric.Kind)).Label("查看"+metric.Label).Grow(1).MinWidth(0).Padding(16, 18).Gap(12).Justify(ui.Start).Background(p.Panel).Border(1, p.Border).Radius(12)
	if button.Hovered() || button.Pressed() {
		button.Background(p.Sidebar)
	}
	if button.FocusVisible() {
		button.BorderColor(c.Theme().Focus)
	}
	button.Children(func() {
		symbol(c, metric.Icon, 20).TextColor(p.Accent)
		ui.Column(c).Grow(1).Gap(5).Children(func() {
			ui.Text(c, fmt.Sprint(a.resourceCount(metric.Kind))).FontSize(20).FontWeight(600)
			ui.Text(c, metric.Label).FontSize(12).TextColor(p.Muted)
		})
		symbol(c, "arrow", 14).TextColor(p.Muted)
	})
	if button.Clicked() {
		a.page = metric.Page
	}
}

func (a *App) connectionControls(c *ui.Context) {
	active := a.connection.Phase != "disconnected" && a.connection.Phase != ""
	if active {
		if ui.Button(c, "断开平台").Height(34).Disabled(a.busy).Clicked() {
			a.disconnect()
		}
	} else {
		if ui.PrimaryButton(c, "连接平台").Height(34).Disabled(a.busy || !a.ready).Clicked() {
			a.connect()
		}
	}
}

func (a *App) pairingPanel(c *ui.Context) {
	p := colors(c)
	panel(c).Padding(0).Gap(0).Shadow(0, 4, 14, -6, p.Text.Alpha(0.08)).Children(func() {
		ui.Row(c).Padding(22, 28).Gap(10).Children(func() {
			symbol(c, "link", 18).TextColor(p.Accent)
			ui.Text(c, "配对设备").FontSize(15).FontWeight(600)
		})
		ui.Divider(c)
		ui.Column(c).Padding(24, 28).Children(func() { a.pairingFields(c) })
	})
}

func (a *App) pairingFields(c *ui.Context) {
	ui.Column(c).Gap(20).Disabled(a.busy).Children(func() {
		ui.Field(c.Key("platform-address"), "平台地址", func() {
			ui.TextInput(c, &a.server).Height(40).Padding(10, 12).Placeholder("https://your-platform.example.com")
		}).FontSize(13)
		ui.Field(c.Key("pair-code"), "配对码", func() {
			ui.TextInput(c, &a.code).Password().Height(40).Padding(10, 12).Placeholder("输入一次性配对码")
		}).Description("在平台的「设备」页面生成配对码，然后粘贴到这里。").FontSize(13)
		if a.deviceID == "" {
			if ui.PrimaryButton(c, "配对并连接").FillWidth().Height(40).Disabled(a.busy || a.code == "" || a.server == "").Clicked() {
				a.pair(false)
			}
			ui.Divider(c)
			ui.Collapsible(c, "恢复已有设备", &a.repairOpen, func() { a.repairFields(c) })
		} else {
			a.repairFields(c)
		}
	})
}

func (a *App) repairFields(c *ui.Context) {
	ui.Column(c).Gap(12).Padding(12, 0, 0, 0).Children(func() {
		ui.Text(c, "使用平台生成的重配码，保留原设备和本机配置。").FontSize(12).TextColor(colors(c).Muted)
		field(c, "设备 ID（仅在配置遗失时重新配对填写）", &a.repairID)
		if ui.Button(c, "重新配对并连接").AlignSelf(ui.Start).Height(34).Disabled(a.busy || a.code == "").Clicked() {
			a.pair(true)
		}
	})
}
