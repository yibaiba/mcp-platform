package desktop

import (
	"context"
	"fmt"
	"io"
	"mcplatform/connector/internal/agent"
	"mcplatform/connector/internal/local/model"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

const appName = "MCP Platform Connector"

type App struct {
	home                                  string
	preferences                           Preferences
	diagnostics                           io.Writer
	win                                   *mygo.Window
	tray                                  *mygo.Tray
	ctx                                   context.Context
	cancel                                context.CancelFunc
	done                                  chan struct{}
	jobs                                  chan func(*worker) error
	refresh                               chan struct{}
	quitting, closing, busy, ready, login bool
	page, search, error, notice           string
	connection                            agent.ConnectionState
	state                                 model.State
	server, code, deviceID, repairID      string
	editor                                editorState
	source                                sourceState
	settings                              Preferences
	drafts                                map[string]editorState
	repairOpen, certificateOpen           bool
}

func New(home string, preferences Preferences, diagnostics io.Writer) *App {
	ctx, cancel := context.WithCancel(context.Background())
	return &App{home: home, preferences: preferences, settings: preferences, diagnostics: diagnostics,
		ctx: ctx, cancel: cancel, done: make(chan struct{}), jobs: make(chan func(*worker) error),
		refresh: make(chan struct{}, 1), busy: true, notice: "正在读取本机配置…", page: "设备连接", connection: agent.ConnectionState{Phase: "disconnected"},
		source: sourceState{Client: "cursor", Kind: "mcp"}}
}

func (a *App) Run() error {
	mygo.App.SetName(appName)
	if !mygo.App.RequestSingleInstanceLock() {
		return nil
	}
	mygo.App.OnSecondInstance(func([]string, string) { a.show() })
	mygo.App.OnActivate(func(bool) { a.show() })
	mygo.App.WhenReady(a.readyApp)
	mygo.App.OnBeforeQuit(a.beforeQuit)
	err := mygo.App.Run()
	a.cancel()
	if a.win != nil {
		<-a.done
	}
	return err
}

func (a *App) readyApp() {
	a.win = mygo.NewWindow(mygo.WindowOptions{Title: "", Width: 1120, Height: 780,
		MinWidth: 900, MinHeight: 640, Hidden: true, Content: ui.View(a.view)})
	// MyGo replaces an empty initial title with the application name.
	a.win.SetTitle("")
	a.setApplicationIcon()
	a.createTray()
	a.login = mygo.App.OpenAtLogin()
	a.win.OnClose(func(e *mygo.CloseEvent) {
		if !a.quitting && a.tray != nil {
			e.PreventDefault()
			a.win.Hide()
		}
	})
	if !mygo.App.WasOpenedAtLogin() || a.tray == nil {
		a.show()
	}
	go a.runWorker()
}

func (a *App) show() {
	if a.win == nil {
		return
	}
	a.win.Show()
	a.win.Focus()
}

func (a *App) beforeQuit(e *mygo.QuitEvent) {
	if a.quitting || a.win == nil {
		return
	}
	e.PreventDefault()
	if a.closing {
		return
	}
	a.closing, a.busy, a.notice = true, true, "正在关闭连接和托管进程…"
	a.cancel()
	go func() {
		<-a.done
		a.win.Update(func() {
			a.quitting = true
			if a.tray != nil {
				a.tray.Destroy()
			}
			mygo.App.Quit()
		})
	}()
}

func (a *App) requestRefresh() {
	select {
	case a.refresh <- struct{}{}:
	default:
	}
}

func (a *App) work(task func(*worker) error) {
	if a.busy || a.closing {
		return
	}
	a.busy, a.error, a.notice = true, "", "正在执行…"
	go func() {
		select {
		case a.jobs <- task:
		case <-a.ctx.Done():
		}
	}()
}

func (a *App) report(err error) {
	if err == nil {
		return
	}
	fmt.Fprintln(a.diagnostics, err)
	a.win.Update(func() { a.error = err.Error(); a.notice = ""; a.show() })
}

func (a *App) changed(state agent.ConnectionState) {
	a.win.Update(func() {
		a.connection = state
		if a.tray != nil {
			a.tray.SetToolTip(appName + " · " + connectionLabel(state.Phase))
		}
	})
}
