package desktop

import (
	"fmt"
	"mcplatform/connector/internal/desktop/branding"
	"runtime"

	"github.com/egoist/mygo"
)

func (a *App) createTray() {
	menu := mygo.NewMenu([]*mygo.MenuItem{
		{Label: "显示设备连接器", Click: func(*mygo.MenuItem, *mygo.Window) { a.show() }},
		{Label: "连接平台", Click: func(*mygo.MenuItem, *mygo.Window) { a.connect() }},
		{Label: "断开平台", Click: func(*mygo.MenuItem, *mygo.Window) { a.disconnect() }},
		mygo.Separator(), {Role: mygo.RoleQuit, Label: "退出连接器"},
	})
	var err error
	template := runtime.GOOS == "darwin"
	a.tray, err = mygo.NewTray(mygo.TrayOptions{ID: "dev.mcplatform.connector.status",
		Icon: branding.Tray(template), IconIsTemplate: template, ToolTip: appName, Menu: menu})
	if err != nil {
		a.error = fmt.Sprintf("托盘创建失败：%v。关闭窗口将退出程序。", err)
		fmt.Fprintln(a.diagnostics, a.error)
		return
	}
	a.tray.OnClick(a.show)
}
