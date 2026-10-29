package desktop

import (
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/local/model"
	"sort"
	"strings"

	"github.com/egoist/mygo/ui"
)

type editorState struct {
	ID, Digest, JSON, Identity string
	Files                      map[string]string
	File, NewFile, ImportPath  string
	Deleting                   bool
	IdentityOpen, FilesOpen    bool
}

func (a *App) resourcesView(c *ui.Context, kind string) {
	if !a.ready {
		ui.Text(c, "本机管理未就绪，请检查错误信息或设置。")
		return
	}
	if len(a.state.Issues) > 0 {
		if ui.Button(c, fmt.Sprintf("扫描发现 %d 个问题，查看来源详情", len(a.state.Issues))).Clicked() {
			a.page = "扫描来源"
		}
	}
	ui.Column(c).Grow(1).MinHeight(0).FillWidth().Background(colors(c).Panel).Border(1, colors(c).Border).Radius(12).Children(func() {
		ui.Row(c).FillWidth().Padding(12, 16).Gap(12).Children(func() {
			symbol(c, "search", 16).TextColor(colors(c).Muted)
			ui.TextInput(c.Key("search-"+kind), &a.search).Grow(1).Height(32).Padding(6, 10).Label("搜索资源").Placeholder("搜索名称、客户端或路径")
			if ui.Button(c, "重新扫描").Height(32).Disabled(a.busy).Clicked() {
				a.request(model.Request{Action: "scan"})
			}
		})
		if kind == "mcp" {
			if ui.Button(c, "导入 MCPB（本机管理页）").Disabled(a.busy).Clicked() {
				a.openBundleManager()
			}
		}
		ui.Divider(c)
		ui.Row(c).Grow(1).MinHeight(0).FillWidth().Children(func() {
			a.resourceList(c, kind)
			ui.Column(c).Grow(1).MinWidth(0).FillHeight().Children(func() { a.editorView(c, kind) })
		})
	})
}

func (a *App) resourceList(c *ui.Context, kind string) {
	ui.Column(c).Width(252).FillHeight().Background(colors(c).Canvas).Border(1, colors(c).Border).BorderWidth(0, 1, 0, 0).Children(func() {
		resources := a.filtered(kind)
		ui.Row(c).Padding(16, 18, 12, 18).Children(func() {
			ui.Text(c, "本机资源").FontSize(11).FontWeight(500).TextColor(colors(c).Muted)
			ui.Spacer(c)
			ui.Text(c, fmt.Sprint(len(resources))).FontSize(11).TextColor(colors(c).Muted)
		})
		ui.Scroll(c.Key("list-" + kind)).Grow(1).FillWidth().Children(func() {
			ui.Column(c).FillWidth().Padding(0, 8, 8, 8).Gap(4).Children(func() {
				if len(resources) == 0 {
					ui.Column(c).Padding(12, 10).Gap(10).Children(func() {
						ui.Text(c, "没有匹配资源").FontSize(13).FontWeight(500)
						ui.Text(c, "添加项目或配置目录后，重新扫描。").FontSize(12).TextColor(colors(c).Muted)
						if quietButton(c, "管理扫描来源").Clicked() {
							a.page = "扫描来源"
						}
					})
				}
				for _, resource := range resources {
					a.resourceRow(c, resource)
				}
			})
		})
	})
}

func (a *App) filtered(kind string) []model.Resource {
	result := []model.Resource{}
	query := strings.ToLower(a.search)
	for _, r := range a.state.Resources {
		haystack := strings.ToLower(strings.Join([]string{r.Name, r.Description, strings.Join(r.Clients, " "), r.Project, r.RealPath, resourceStatus(r)}, " "))
		if r.Kind == kind && strings.Contains(haystack, query) {
			result = append(result, r)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Name == result[j].Name {
			return result[i].ID < result[j].ID
		}
		return result[i].Name < result[j].Name
	})
	return result
}

func resourceStatus(r model.Resource) string {
	label := r.Runtime
	switch r.Runtime {
	case "connected":
		label = "已连接"
	case "connecting":
		label = "连接中"
	case "error":
		label = "连接错误"
	}
	result := []string{label}
	if r.Runtime == "client-managed" {
		result = []string{"由客户端管理"}
	}
	if r.Selected {
		result = append(result, "已纳管")
	} else {
		result = append(result, "未纳管")
	}
	if r.ReadOnly {
		result = append(result, "只读")
	}
	if r.Deleted {
		result = append(result, "已删除")
	}
	if r.ReloadRequired {
		result = append(result, "客户端待重新加载")
	}
	return strings.Join(result, " · ")
}

func (a *App) resourceRow(c *ui.Context, r model.Resource) {
	p := colors(c)
	row := ui.Column(c.Key(r.ID)).Padding(12).Gap(8).Radius(8)
	if a.editor.ID == r.ID {
		row.Background(p.Selected)
	}
	row.Children(func() {
		button := ui.ButtonBase(c.Key("resource-" + r.ID)).Label(r.Name).FillWidth().Gap(10).AlignItems(ui.Start).Justify(ui.Start).Radius(6)
		if button.FocusVisible() {
			button.Border(1, c.Theme().Focus)
		}
		button.Children(func() {
			icon := "resources"
			if r.Kind == "skill" {
				icon = "skill"
			}
			symbol(c, icon, 18).TextColor(p.Accent).Margin(2, 0, 0, 0)
			ui.Column(c).Grow(1).MinWidth(0).Gap(5).Children(func() {
				ui.Text(c, r.Name).FontSize(13).FontWeight(600).SingleLine().Ellipsis("…")
				if r.Description != "" {
					ui.Text(c, r.Description).FontSize(12).TextColor(p.Muted).MaxLines(1)
				}
				ui.Text(c, strings.Join(r.Clients, " · ")).FontSize(11).TextColor(p.Muted)
			})
		})
		if button.Hovered() && a.editor.ID != r.ID {
			row.Background(p.Hover)
		}
		if button.Clicked() {
			a.selectResource(r)
		}
		ui.Text(c, resourceStatus(r)).FontSize(11).TextColor(p.Muted)
		selected := r.Selected
		if ui.Checkbox(c.Key("selected-"+r.ID), &selected, "纳入设备同步").FontSize(12).Disabled(a.busy || r.ReadOnly || r.Deleted).Changed() {
			a.request(model.Request{Action: "select", ID: r.ID, Selected: selected})
		}
		for _, issue := range r.Issues {
			ui.Text(c, issue).FontSize(12).TextColor(c.Theme().Danger)
		}
	})
}

func newEditor(r model.Resource) (editorState, error) {
	var value any
	if err := json.Unmarshal(r.Content, &value); err != nil {
		return editorState{}, err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return editorState{}, err
	}
	editor := editorState{ID: r.ID, Digest: r.Digest, JSON: string(data), Files: map[string]string{}}
	if r.Kind == "skill" {
		if err := json.Unmarshal(r.Content, &editor.Files); err != nil {
			return editorState{}, err
		}
		editor.File = "SKILL.md"
	}
	return editor, nil
}

func (a *App) selectResource(r model.Resource) {
	if a.editor.ID == r.ID {
		return
	}
	if a.drafts == nil {
		a.drafts = map[string]editorState{}
	}
	if a.editor.ID != "" {
		a.drafts[a.editor.ID] = a.editor
	}
	if draft, ok := a.drafts[r.ID]; ok {
		a.editor = draft
		return
	}
	editor, err := newEditor(r)
	if err != nil {
		a.error = err.Error()
		return
	}
	a.editor = editor
}
