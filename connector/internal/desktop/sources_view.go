package desktop

import (
	"fmt"
	"mcplatform/connector/internal/local/model"
	"mcplatform/connector/internal/local/sources"

	"github.com/egoist/mygo/ui"
)

type sourceState struct {
	Client, Kind, Path, Project string
	ReadOnly                    bool
}

func (a *App) sourcesView(c *ui.Context) {
	if !a.ready {
		ui.Text(c, "本机管理未就绪，请检查错误信息或设置。")
		return
	}
	ui.Scroll(c).Grow(1).FillWidth().Children(func() {
		ui.Column(c).FillWidth().MaxWidth(760).Gap(20).Children(func() {
			panel(c).Children(func() {
				sectionTitle(c, "添加项目", "自动发现项目内受支持的 MCP 配置和 Skills 目录。")
				a.pathField(c, "项目目录（绝对路径）", pathSelection{Target: &a.source.Project, Directory: true})
				if ui.Button(c, "添加项目").AlignSelf(ui.End).Height(34).Disabled(a.busy || a.source.Project == "").Clicked() {
					a.request(model.Request{Action: "project.add", Project: a.source.Project})
				}
			})
			a.customSource(c)
			panel(c).Children(func() { a.sourceList(c) })
		})
	})
}

func (a *App) customSource(c *ui.Context) {
	panel(c).Children(func() {
		sectionTitle(c, "自定义来源", "指定应用配置文件或 Skills 根目录，扫描不会执行其中的命令。")
		ui.Row(c).Gap(16).Children(func() {
			ui.Column(c).Grow(1).Children(func() {
				ui.Field(c, "客户端", func() {
					ui.Select(c, &a.source.Client, []string{"cursor", "claude", "codex", "pi"}).FillWidth().Height(36)
				})
			})
			ui.Column(c).Grow(1).Children(func() {
				ui.Field(c, "资源类型", func() { ui.Select(c, &a.source.Kind, []string{"mcp", "skill"}).FillWidth().Height(36) })
			})
		})
		a.pathField(c, "配置文件或 Skills 根目录（绝对路径）", pathSelection{Target: &a.source.Path, Directory: a.source.Kind == "skill"})
		ui.Checkbox(c.Key("source-readonly"), &a.source.ReadOnly, "由系统或供应商管理（只读）").FontSize(13)
		if ui.Button(c, "添加来源").AlignSelf(ui.End).Height(34).Disabled(a.busy || a.source.Path == "").Clicked() {
			source := sources.New(a.source.Client, a.source.Kind, a.source.Path, "")
			source.ReadOnly = a.source.ReadOnly
			a.request(model.Request{Action: "source.add", Source: &source})
		}
	})
}

func (a *App) sourceList(c *ui.Context) {
	ui.Text(c, fmt.Sprintf("已添加的来源 · %d", len(a.state.Sources))).FontSize(16).FontWeight(600)
	for _, source := range a.state.Sources {
		ui.Row(c.Key(source.ID)).Gap(12).Children(func() {
			symbol(c, "folder", 18).TextColor(colors(c).Muted)
			ui.Column(c).Grow(1).MinWidth(0).Gap(4).Children(func() {
				ui.Text(c, source.Client+" · "+source.Kind).FontSize(13).FontWeight(500)
				ui.Text(c, source.Path).FontSize(12).TextColor(colors(c).Muted)
			})
			if quietButton(c.Key("remove-"+source.ID), "移除").Label("移除来源").Disabled(a.busy).Clicked() {
				a.request(model.Request{Action: "source.remove", ID: source.ID})
			}
		})
	}
	for _, issue := range a.state.Issues {
		ui.Text(c, issue).FontSize(12).TextColor(c.Theme().Danger)
	}
}
