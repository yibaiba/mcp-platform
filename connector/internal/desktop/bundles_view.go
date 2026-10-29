package desktop

import (
	"context"
	"errors"
	"fmt"
	"github.com/egoist/mygo"
	"mcplatform/connector/internal/localhttp"
	"time"
)

func (a *App) openBundleManager() {
	a.work(func(w *worker) error {
		if w.session == nil {
			return fmt.Errorf("本机管理未启动")
		}
		// Each launch gets a fresh one-use login link; never reuse a consumed open token.
		if err := w.closeLocalHTTP(); err != nil {
			return err
		}
		server, err := localhttp.Start(w.session.Runtime.Local)
		if err != nil {
			return err
		}
		w.localHTTP = server
		go func() {
			if err := server.Serve(); err != nil {
				a.report(err)
			}
		}()
		if err = mygo.Shell.OpenExternal(server.OpenURL()); err != nil {
			return errors.Join(err, w.closeLocalHTTP())
		}
		return nil
	})
}
func (w *worker) closeLocalHTTP() error {
	if w.localHTTP == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := w.localHTTP.Close(ctx)
	w.localHTTP = nil
	return err
}
