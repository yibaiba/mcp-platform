package desktop

import (
	"context"
	"fmt"
	"mcplatform/connector/internal/config"
	"mcplatform/connector/internal/local/model"
	"mcplatform/connector/internal/pairing"
	"mcplatform/connector/internal/platformclient"
	"time"
)

type worker struct {
	app         *App
	session     *Session
	preferences Preferences
	unsubscribe func()
}

func (a *App) runWorker() {
	defer close(a.done)
	w := &worker{app: a, preferences: a.preferences}
	defer func() {
		if err := w.close(); err != nil {
			a.report(err)
		}
	}()
	if err := w.open(a.preferences); err != nil {
		a.report(err)
	} else if err := a.preferences.Save(a.home); err != nil {
		a.report(err)
	}
	w.publish()
	a.win.Update(func() { a.busy = false; a.notice = "" })
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-a.ctx.Done():
			return
		case task := <-a.jobs:
			err := task(w)
			w.publish()
			a.win.Update(func() {
				a.busy = false
				if err != nil {
					a.error, a.notice = err.Error(), ""
				} else {
					a.notice = "请求已处理"
				}
			})
		case <-a.refresh:
			w.publish()
		case <-ticker.C:
			w.publish()
		}
	}
}

func (w *worker) close() error {
	if w.unsubscribe != nil {
		w.unsubscribe()
		w.unsubscribe = nil
	}
	if w.session == nil {
		return nil
	}
	session := w.session
	w.session = nil
	err := session.Runtime.Close()
	session.Client.CloseIdleConnections()
	return err
}

func (w *worker) open(preferences Preferences) error {
	if err := w.close(); err != nil {
		return err
	}
	a := w.app
	session, err := OpenSession(a.ctx, SessionOptions{Home: a.home, Preferences: preferences,
		Diagnostics: a.diagnostics, Changed: a.changed, Error: a.report})
	if err != nil {
		return err
	}
	w.session, w.preferences = session, preferences
	w.unsubscribe = session.Runtime.Local.Subscribe(a.requestRefresh)
	cfg := session.Config
	a.win.Update(func() {
		a.server, a.deviceID = cfg.Server, cfg.DeviceID
		a.code, a.repairID = "", ""
		a.network = networkDraft{}
	})
	if cfg.DeviceID != "" {
		return session.Runtime.Connect(cfg)
	}
	return nil
}

func (w *worker) publish() {
	if w.session == nil {
		w.app.win.Update(func() { w.app.ready = false; w.app.state = model.State{} })
		return
	}
	result, err := w.session.Runtime.Local.Execute(w.app.ctx, model.Request{Action: "state"}, false)
	if err != nil {
		w.app.report(err)
		return
	}
	state := result.(model.State)
	w.app.win.Update(func() { w.app.state, w.app.ready = state, true })
}

func (a *App) request(request model.Request) {
	request.ExpectedRevision = a.state.Revision
	request.OperationID = operationID()
	a.work(func(w *worker) error {
		if w.session == nil {
			return fmt.Errorf("本机管理未启动，请检查设置及错误信息")
		}
		_, err := w.session.Runtime.Local.Execute(a.ctx, request, false)
		return err
	})
}

func (a *App) connect() {
	a.work(func(w *worker) error {
		if w.session == nil {
			return fmt.Errorf("本机管理未启动")
		}
		cfg, err := config.Load(w.preferences.ConfigPath)
		if err != nil {
			return err
		}
		return w.session.Runtime.Connect(cfg)
	})
}

func (a *App) disconnect() {
	a.work(func(w *worker) error {
		if w.session == nil {
			return fmt.Errorf("本机管理未启动")
		}
		return w.session.Runtime.Disconnect()
	})
}

func (a *App) pair(repair bool) {
	input := pairing.Options{Action: "pair", Server: a.server, DeviceID: a.repairID, Code: a.code}
	if repair {
		input.Action = "re-pair"
	}
	a.work(func(w *worker) error {
		client, err := platformclient.New(w.preferences.CAPath)
		if err != nil {
			return err
		}
		if w.session != nil {
			client = w.session.Runtime.Client()
			if err := w.session.Runtime.Disconnect(); err != nil {
				return err
			}
		}
		input.Path = w.preferences.ConfigPath
		ctx, cancel := context.WithTimeout(a.ctx, 60*time.Second)
		defer cancel()
		if _, err := pairing.Save(ctx, client, input); err != nil {
			return err
		}
		return w.open(w.preferences)
	})
}

func (a *App) applySettings() {
	next := a.settings
	a.work(func(w *worker) error {
		if err := next.Validate(); err != nil {
			return err
		}
		if err := w.open(next); err != nil {
			return err
		}
		if err := next.Save(a.home); err != nil {
			return err
		}
		a.win.Update(func() { a.preferences = next; a.editor = editorState{} })
		return nil
	})
}
