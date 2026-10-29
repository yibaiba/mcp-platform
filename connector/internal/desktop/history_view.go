package desktop

import (
	"encoding/json"
	"fmt"
	"mcplatform/connector/internal/local/model"
	"sort"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

func phaseLabel(phase string) string {
	switch phase {
	case "succeeded":
		return "成功"
	case "failed":
		return "失败"
	case "running":
		return "执行中"
	case "prepared":
		return "写入待核对"
	case "interrupted":
		return "已中断"
	default:
		return phase
	}
}

func (a *App) historyView(c *ui.Context) {
	operations := make([]model.Operation, 0, len(a.state.Operations))
	for _, op := range a.state.Operations {
		operations = append(operations, op)
	}
	sort.Slice(operations, func(i, j int) bool { return operations[i].CreatedAt > operations[j].CreatedAt })
	if len(operations) == 0 {
		panel(c).Grow(1).Children(func() {
			emptyView(c, emptyState{Icon: "history", Title: "还没有操作记录", Description: "扫描、编辑和同步的结果会显示在这里。"})
		})
		return
	}
	ui.Scroll(c).Grow(1).FillWidth().Children(func() {
		ui.Column(c).FillWidth().MaxWidth(760).Gap(12).Children(func() {

			for _, op := range operations {
				a.operationView(c, op)
			}
		})
	})
}

func (a *App) operationView(c *ui.Context, op model.Operation) {
	panel(c.Key(op.ID)).Padding(20).Gap(10).Children(func() {
		ui.Row(c).Gap(12).Children(func() {
			symbol(c, "history", 18).TextColor(colors(c).Muted)
			ui.Text(c, operationLabel(op.Action)).FontSize(14).FontWeight(600).Grow(1)
			ui.Text(c, phaseLabel(op.Phase)).FontSize(12).TextColor(colors(c).Muted)
		})
		ui.Text(c, op.CreatedAt).FontSize(12).TextColor(c.Theme().TextMuted)
		if op.Error != "" {
			ui.Text(c, op.Error).TextColor(c.Theme().Danger)
		}
		if op.Backup == "" || op.ResourceID == "" {
			return
		}
		if ui.Button(c.Key("backup-"+op.ID), "载入修改前副本到编辑器").Disabled(a.busy).Clicked() {
			a.loadBackup(op)
		}
		if ui.Button(c.Key("restore-"+op.ID), "恢复此修改前的副本…").Disabled(a.busy).Clicked() {
			a.restoreBackup(op)
		}
	})
}

func (a *App) loadBackup(op model.Operation) {
	r, ok := a.state.Resources[op.ResourceID]
	if !ok {
		a.error = "该记录关联的资源不存在。"
		return
	}
	a.work(func(w *worker) error {
		if w.session == nil {
			return fmt.Errorf("本机管理未启动")
		}
		result, err := w.session.Runtime.Local.Execute(a.ctx, model.Request{Action: "backup", ID: op.ID}, false)
		if err != nil {
			return err
		}
		r.Content = result.(json.RawMessage)
		editor, err := newEditor(r)
		if err != nil {
			return err
		}
		a.win.Update(func() {
			a.selectResource(r)
			a.editor = editor
			if r.Kind == "skill" {
				a.page = "Skills"
			} else {
				a.page = "MCP"
			}
		})
		return nil
	})
}

func (a *App) restoreBackup(op model.Operation) {
	r, ok := a.state.Resources[op.ResourceID]
	if !ok {
		a.error = "该记录关联的资源不存在。"
		return
	}
	result, err := mygo.Dialog.Message(mygo.MessageOptions{Parent: a.win, Type: mygo.MessageWarning,
		Title: "恢复本机副本", Message: "确认恢复此修改前的内容？当前内容会先保存恢复副本。", Buttons: []string{"取消", "恢复"}, CancelButton: 0})
	if err != nil {
		a.error = err.Error()
		return
	}
	if result.Button != 1 {
		return
	}
	content, err := json.Marshal(map[string]string{"operationId": op.ID})
	if err != nil {
		a.error = err.Error()
		return
	}
	a.request(model.Request{Action: "restore", ID: r.ID, ExpectedDigest: r.Digest, Content: content, Confirm: true})
}

func operationLabel(action string) string {
	labels := map[string]string{"scan": "扫描资源", "select": "更新同步选择", "edit": "编辑资源", "delete": "删除资源", "restore": "恢复副本", "start": "连接 MCP 服务", "stop": "停止 MCP 会话", "project.add": "添加项目", "source.add": "添加来源", "source.remove": "移除来源", "identity.bind": "绑定本机身份"}
	if label, ok := labels[action]; ok {
		return label
	}
	return action
}
