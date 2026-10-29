package desktop

import (
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/local/model"

	"github.com/egoist/mygo/ui"
)

func (a *App) editorView(c *ui.Context, kind string) {
	r, ok := a.state.Resources[a.editor.ID]
	if !ok || r.Kind != kind {
		ui.Column(c).Fill().Padding(0).Children(func() {
			emptyView(c, emptyState{Icon: "resources", Title: "选择一个资源", Description: "查看配置、编辑文件，或管理连接器持有的会话。"})
		})
		return
	}
	ui.Scroll(c.Key("editor-" + r.ID)).Grow(1).FillWidth().Children(func() {
		ui.Column(c).FillWidth().Padding(24).Gap(18).Children(func() {
			ui.Column(c).Gap(8).Children(func() {
				ui.Text(c, r.Name).FontSize(20).FontWeight(600)
				ui.Text(c, r.RealPath).FontSize(11).TextColor(colors(c).Muted)
			})
			a.editorActions(c, r)
			ui.Divider(c)
			a.editorConflict(c, r)
			if kind == "skill" {
				a.skillEditor(c, r.ReadOnly)
			} else {
				ui.Row(c).FillWidth().Children(func() {
					ui.Text(c, "配置内容").FontSize(12).FontWeight(500).TextColor(colors(c).Muted)
					ui.Spacer(c)
					ui.Text(c, "JSON").Font("monospace").FontSize(11).TextColor(colors(c).Muted)
				})
				ui.TextArea(c.Key("json-"+r.ID), &a.editor.JSON).Height(280).Padding(14).Font("monospace").FontSize(13).Background(colors(c).Canvas).Label("MCP 配置 JSON").ReadOnly(r.ReadOnly || a.busy)
			}
			ui.Text(c, "修改保存后，需要在使用它的客户端中重新加载。").FontSize(12).TextColor(colors(c).Muted)
			if kind == "mcp" {
				a.identityView(c, r)
			}
			a.deleteView(c, r)
		})
	})
}

func (a *App) editorConflict(c *ui.Context, r model.Resource) {
	if r.Digest == a.editor.Digest {
		return
	}
	ui.Text(c, "来源已变化，草稿已保留。请比较当前来源后再重新载入。").TextColor(c.Theme().Warning)
	latest := string(r.Content)
	ui.TextArea(c.Key("current-source"), &latest).ReadOnly(true).Height(120).Label("当前来源内容")
	if ui.Button(c, "放弃草稿并重新载入来源").Disabled(a.busy).Clicked() {
		editor, err := newEditor(r)
		if err != nil {
			a.error = err.Error()
		} else {
			a.editor = editor
		}
	}
}

func (a *App) editorActions(c *ui.Context, r model.Resource) {
	ui.Row(c).Gap(8).Wrap().Children(func() {
		if ui.PrimaryButton(c, "保存修改").Height(34).Disabled(a.busy || r.ReadOnly).Clicked() {
			a.saveEditor(r)
		}
		if r.Kind != "mcp" {
			return
		}
		if ui.Button(c, "由连接器连接").Height(34).Disabled(a.busy || r.ReadOnly || r.Deleted).Clicked() {
			a.request(model.Request{Action: "start", ID: r.ID})
		}
		if ui.Button(c, "停止连接器会话").Height(34).Disabled(a.busy || r.Runtime == "client-managed").Clicked() {
			a.request(model.Request{Action: "stop", ID: r.ID})
		}
	})
}

func (a *App) identityView(c *ui.Context, r model.Resource) {
	ui.Divider(c)
	ui.Collapsible(c, "独立身份与凭证绑定", &a.editor.IdentityOpen, func() {
		ui.Column(c).Gap(12).Padding(12, 0, 0, 0).Children(func() {
			field(c, "独立身份授权绑定 ID", &a.editor.Identity)
			if ui.Button(c, "绑定当前本机资源").AlignSelf(ui.Start).Disabled(a.busy || !r.Selected || a.editor.Identity == "").Clicked() {
				a.request(model.Request{Action: "identity.bind", ID: r.ID, Identity: a.editor.Identity})
			}
		})
	})
}

func (a *App) deleteView(c *ui.Context, r model.Resource) {
	if r.ReadOnly {
		return
	}
	ui.Divider(c)
	if !a.editor.Deleting {
		if quietButton(c, "删除资源…").AlignSelf(ui.Start).TextColor(c.Theme().Danger).Disabled(a.busy || r.Deleted).Clicked() {
			a.editor.Deleting = true
		}
		return
	}
	ui.Text(c, "确认删除所选资源？修改前会保存本机恢复副本。").TextColor(c.Theme().Danger)
	ui.Row(c).Gap(8).Children(func() {
		if ui.Button(c, "确认删除").Disabled(a.busy).Clicked() {
			a.request(model.Request{Action: "delete", ID: r.ID, ExpectedDigest: a.editor.Digest, Confirm: true})
			a.editor.Deleting = false
		}
		if ui.Button(c, "取消删除").Clicked() {
			a.editor.Deleting = false
		}
	})
}

func (a *App) saveEditor(r model.Resource) {
	content := json.RawMessage(a.editor.JSON)
	if r.Kind == "skill" {
		var err error
		content, err = json.Marshal(a.editor.Files)
		if err != nil {
			a.error = err.Error()
			return
		}
	}
	if !json.Valid(content) {
		a.error = "配置不是有效的 JSON，请修正后再保存。"
		return
	}
	request := model.Request{Action: "edit", ID: r.ID, ExpectedDigest: a.editor.Digest,
		ExpectedRevision: a.state.Revision, OperationID: operationID(), Content: content}
	a.work(func(w *worker) error {
		if w.session == nil {
			return fmt.Errorf("本机管理未启动")
		}
		result, err := w.session.Runtime.Local.Execute(a.ctx, request, false)
		if err != nil {
			return err
		}
		op := result.(model.Operation)
		var saved struct {
			Digest string `json:"digest"`
		}
		if err := json.Unmarshal(op.Result, &saved); err != nil {
			return err
		}
		a.win.Update(func() { a.savedDigest(r.ID, saved.Digest) })
		return nil
	})
}

func (a *App) savedDigest(id, digest string) {
	if a.editor.ID == id {
		a.editor.Digest = digest
		return
	}
	if draft, ok := a.drafts[id]; ok {
		draft.Digest = digest
		a.drafts[id] = draft
	}
}
