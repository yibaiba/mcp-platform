package desktop

import (
	"encoding/json"
	"fmt"
	"github.com/egoist/mygo/ui"
	"mcplatform/connector/internal/local/model"
	"mcplatform/connector/internal/network"
	"net/url"
)

type networkDraft struct {
	Loaded  bool
	View    network.View
	Auth    [5]string
	Replace [5]bool
	Clear   [5]bool
	Results string
}

func (a *App) networkView(c *ui.Context) {
	panel(c).Gap(12).Children(func() {
		sectionTitle(c, "网络与安装源", "仅作用于本机。保存后请重新连接平台通道；现有 MCP 进程保持运行。")
		if !a.network.Loaded {
			if ui.Button(c, "读取网络设置").Disabled(a.busy).Clicked() {
				a.loadNetwork()
			}
			return
		}
		s := &a.network.View.Settings
		for _, f := range []struct {
			label string
			value *string
		}{{"HTTP 代理", &s.HTTPProxy}, {"HTTPS 请求代理（留空使用 HTTP 代理）", &s.HTTPSProxy}, {"NO_PROXY", &s.NoProxy}, {"npm 公共镜像", &s.NPMRegistry}, {"Python 公共索引", &s.PythonIndex}, {"GitHub API 基地址", &s.GitHubAPI}, {"下载模板：{url} 或 {encodedUrl}", &s.GitHubDownload}, {"Git 克隆模板：{owner}/{repo}", &s.GitHubClone}} {
			field(c, f.label, f.value)
		}
		previewNetwork(c, *s)
		ui.Checkbox(c, &s.ReplacePublicSources, "替换明确声明的官方公共源；保留私有源")
		labels := []string{"HTTP 代理账号:密码", "HTTPS 代理账号:密码", "GitHub API 独立令牌", "GitHub 下载独立令牌", "GitHub Git 独立令牌"}
		for i, name := range network.SecretNames {
			status := "未设置"
			if a.network.View.Secrets[name] {
				status = "已保存"
			}
			ui.Text(c, labels[i]+" · "+status+"（默认保留）")
			ui.Checkbox(c.Key(name+"-replace"), &a.network.Replace[i], "更换")
			ui.Checkbox(c.Key(name+"-clear"), &a.network.Clear[i], "清除")
			if a.network.Replace[i] {
				ui.TextInput(c.Key(name+"-value"), &a.network.Auth[i]).Password().FillWidth().Label(labels[i] + "新值")
			}
		}
		ui.Text(c, "第三方加速端点只使用单独配置的凭证；代理或包源失败不会自动直连或切换来源。").FontSize(12)
		if ui.PrimaryButton(c, "保存网络设置").Disabled(a.busy).Clicked() {
			a.saveNetwork()
		}
		if ui.Button(c, "检查已保存设置的 API / 下载 / Git").Disabled(a.busy).Clicked() {
			a.checkNetwork()
		}
		ui.Text(c, a.network.Results).FontSize(12)
	})
}
func (a *App) loadNetwork() {
	a.work(func(w *worker) error {
		if w.session == nil {
			return fmt.Errorf("本机管理未启动")
		}
		view := w.session.Runtime.Network.View()
		a.win.Update(func() { a.network = networkDraft{Loaded: true, View: view} })
		return nil
	})
}
func (a *App) saveNetwork() {
	input := network.Save{Revision: a.network.View.Revision, Settings: a.network.View.Settings, Secrets: map[string]network.Edit{}}
	for i, name := range network.SecretNames {
		if a.network.Replace[i] && a.network.Clear[i] {
			a.error = "同一凭证不能同时更换和清除"
			return
		}
		if a.network.Replace[i] {
			input.Secrets[name] = network.Edit{Action: "replace", Value: a.network.Auth[i]}
		}
		if a.network.Clear[i] {
			input.Secrets[name] = network.Edit{Action: "clear"}
		}
	}
	a.work(func(w *worker) error {
		if w.session == nil {
			return fmt.Errorf("本机管理未启动")
		}
		raw, err := json.Marshal(input)
		if err != nil {
			return err
		}
		value, err := w.session.Runtime.Local.Execute(a.ctx, model.Request{Action: "network.save", Content: raw}, false)
		view, _ := value.(network.View)
		if err != nil {
			return err
		}
		a.win.Update(func() {
			a.network = networkDraft{Loaded: true, View: view, Results: "已保存；请断开并重新连接平台通道。"}
		})
		return nil
	})
}
func (a *App) checkNetwork() {
	a.work(func(w *worker) error {
		if w.session == nil {
			return fmt.Errorf("本机管理未启动")
		}
		result, err := w.session.Runtime.Local.Execute(a.ctx, model.Request{Action: "network.check"}, false)
		if err != nil {
			return err
		}
		raw, err := json.MarshalIndent(result, "", "  ")
		if err != nil {
			return err
		}
		a.win.Update(func() { a.network.Results = string(raw) })
		return nil
	})
}

func previewNetwork(c *ui.Context, settings network.Settings) {
	config := network.Config{Settings: settings}
	if err := settings.Validate(); err != nil {
		ui.Text(c, "地址预览："+err.Error()).FontSize(12)
		return
	}
	original, _ := url.Parse("https://github.com/yibaiba/mcp-platform/archive/0123456789abcdef.zip?download=1")
	target, _, err := network.Rewrite(original, config)
	if err == nil && settings.GitHubDownload != "" {
		ui.Text(c, "下载预览："+target.String()).FontSize(12)
	}
	clone, err := network.CloneURL("https://github.com/yibaiba/mcp-platform.git", config)
	if err == nil && settings.GitHubClone != "" {
		ui.Text(c, "Git 预览："+clone).FontSize(12)
	}
}
