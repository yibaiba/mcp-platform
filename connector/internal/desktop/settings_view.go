package desktop

import (
	"fmt"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

func (a *App) settingsView(c *ui.Context) {
	ui.Scroll(c).Grow(1).FillWidth().Children(func() {
		ui.Column(c).FillWidth().MaxWidth(760).Gap(20).Children(func() {
			panel(c).Children(func() {
				sectionTitle(c, "启动与驻留", "登录后保持连接，关闭窗口后继续在菜单栏运行。")
				login := a.login
				if ui.Checkbox(c.Key("login"), &login, "登录后自动启动并驻留托盘").Disabled(a.busy).Changed() {
					if err := mygo.App.SetOpenAtLogin(login); err != nil {
						a.error = fmt.Sprintf("设置登录启动失败：%v", err)
					} else {
						a.login = mygo.App.OpenAtLogin()
					}
				}
			})
			panel(c).Gap(18).Disabled(a.busy).Children(func() {
				sectionTitle(c, "存储位置", "沿用已有配置，或为本机管理选择独立的数据目录。")
				a.pathField(c, "连接器配置文件（绝对路径）", pathSelection{Target: &a.settings.ConfigPath})
				a.pathField(c, "本机数据目录（留空使用配置或默认目录）", pathSelection{Target: &a.settings.DataDir, Directory: true})
				ui.Divider(c)
				ui.Collapsible(c, "私有 CA 证书", &a.certificateOpen, func() {
					a.pathField(c, "私有 CA PEM 文件（可留空）", pathSelection{Target: &a.settings.CAPath})
				})
				ui.Row(c).Justify(ui.End).Children(func() {
					if ui.PrimaryButton(c, "应用并保存设置").Height(36).Disabled(a.busy).Clicked() {
						a.applySettings()
					}
				})
			})
			ui.Text(c, "移动应用后请重新设置登录启动。macOS 请从 .app 启动。").FontSize(12).TextColor(colors(c).Muted)
		})
	})
}

func (a *App) pathField(c *ui.Context, label string, selection pathSelection) {
	ui.Row(c).AlignItems(ui.End).Gap(10).Children(func() {
		ui.Column(c).Grow(1).Children(func() { field(c, label, selection.Target) })
		a.choosePath(c, "选择…", selection)
	})
}

type pathSelection struct {
	Target    *string
	Directory bool
}

func (a *App) choosePath(c *ui.Context, label string, selection pathSelection) {
	if !ui.Button(c.Key(label), label).Height(36).Disabled(a.busy).Clicked() {
		return
	}
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: a.win, Title: label, Directory: selection.Directory})
	if err != nil {
		a.error = err.Error()
		return
	}
	if len(paths) > 0 {
		*selection.Target = paths[0]
	}
}
