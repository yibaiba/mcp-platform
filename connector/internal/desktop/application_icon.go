package desktop

import (
	"fmt"
	"runtime"

	"github.com/egoist/mygo"
	"mcplatform/connector/internal/desktop/branding"
)

func (a *App) setApplicationIcon() {
	var err error
	if runtime.GOOS == "darwin" {
		err = mygo.App.Dock.SetIcon(branding.Application())
	} else {
		err = a.win.SetIcon(branding.Application())
	}
	if err != nil {
		a.error = fmt.Sprintf("设置应用图标失败：%v", err)
		fmt.Fprintln(a.diagnostics, a.error)
	}
}
