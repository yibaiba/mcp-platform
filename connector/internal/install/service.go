package install

import (
	"context"
	"fmt"
	"github.com/kardianos/service"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

type Program struct {
	Run    func(context.Context) error
	cancel context.CancelFunc
	done   chan error
}

func (p *Program) Start(service.Service) error {
	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	p.done = make(chan error, 1)
	go func() { p.done <- p.Run(ctx) }()
	return nil
}
func (p *Program) Stop(service.Service) error { p.cancel(); return <-p.done }
func Configure(program *Program, path, scope string) (service.Service, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	option := service.KeyValue{}
	if scope == "user" {
		option["UserService"] = true
	}
	return service.New(program, &service.Config{Name: "MCPPlatformConnector", DisplayName: "MCP Platform Connector", Description: "Outbound device connection for MCP Platform", Arguments: []string{"run", "--config", absolute}, Option: option})
}
func Control(program *Program, path, scope, action string) error {
	if scope != "user" && scope != "system" {
		return fmt.Errorf("scope must be user or system")
	}
	if runtime.GOOS == "windows" && scope == "user" {
		return windowsLogin(path, action)
	}
	svc, err := Configure(program, path, scope)
	if err != nil {
		return err
	}
	return service.Control(svc, action)
}
func windowsLogin(path, action string) error {
	if action == "uninstall" {
		return exec.Command("schtasks.exe", "/Delete", "/TN", "MCPPlatformConnectorUser", "/F").Run()
	}
	if action != "install" {
		return fmt.Errorf("Windows user tasks support install/uninstall; use Task Scheduler to run or stop")
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	command := fmt.Sprintf("\"%s\" run --config \"%s\"", executable, absolute)
	cmd := exec.Command("schtasks.exe", "/Create", "/TN", "MCPPlatformConnectorUser", "/SC", "ONLOGON", "/IT", "/TR", command)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
