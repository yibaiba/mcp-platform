package desktop

import (
	"encoding/base64"
	"encoding/json"
	"image/png"
	"io"
	"mcplatform/connector/internal/local/model"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo/ui"
)

func testApp(t *testing.T) *App {
	t.Helper()
	a := New(t.TempDir(), Preferences{}, io.Discard)
	t.Cleanup(a.cancel)
	a.ready, a.busy, a.notice = true, false, ""
	a.state = model.State{Resources: map[string]model.Resource{}, Operations: map[string]model.Operation{}}
	return a
}

func TestNativeNavigationAndPairingForm(t *testing.T) {
	a := testApp(t)
	tester := ui.NewTester(a.view, 1120, 780)
	if directory := os.Getenv("CONNECTOR_UI_SNAPSHOTS"); directory != "" {
		saveView(t, tester, filepath.Join(directory, "connection-light.png"))
		tester.SetDark(true)
		saveView(t, tester, filepath.Join(directory, "connection-dark.png"))
		tester.SetDark(false)
	}
	if !tester.HasText("配对设备") || !tester.HasText("未连接") {
		t.Fatal(tester.Texts())
	}
	if err := tester.Click("平台地址"); err != nil {
		t.Fatal(err)
	}
	tester.Type("https://example.com")
	if a.server != "https://example.com" {
		t.Fatal(a.server)
	}
	for _, page := range []string{"MCP", "Skills", "扫描来源", "操作记录", "设置"} {
		if err := tester.Click(page); err != nil {
			t.Fatal(err)
		}
		if a.page != page {
			t.Fatalf("page=%s", a.page)
		}
		if directory := os.Getenv("CONNECTOR_UI_SNAPSHOTS"); directory != "" {
			saveView(t, tester, filepath.Join(directory, "navigation-"+page+".png"))
		}
	}
}

func TestResourceDraftSurvivesSourceChangesAndNavigation(t *testing.T) {
	a := testApp(t)
	first := model.Resource{ID: "first", Kind: "mcp", Name: "本机服务", Digest: "one", Description: "已发现的本机 MCP 配置", Clients: []string{"cursor"}, Runtime: "client-managed", RealPath: "/Users/example/.cursor/mcp.json", Content: json.RawMessage(`{"command":"example"}`)}
	second := first
	second.ID, second.Name = "second", "另一个服务"
	a.state.Resources[first.ID], a.state.Resources[second.ID] = first, second
	a.page = "MCP"
	a.selectResource(first)
	a.editor.JSON = `{"command":"user draft"}`
	a.selectResource(second)
	a.selectResource(first)
	if a.editor.JSON != `{"command":"user draft"}` {
		t.Fatal("draft lost on navigation")
	}
	if directory := os.Getenv("CONNECTOR_UI_SNAPSHOTS"); directory != "" {
		preview := ui.NewTester(a.view, 1120, 780)
		saveView(t, preview, filepath.Join(directory, "manager-light.png"))
		preview.SetDark(true)
		saveView(t, preview, filepath.Join(directory, "manager-dark.png"))
	}
	first.Digest = "changed"
	a.state.Resources[first.ID] = first
	tester := ui.NewTester(a.view, 1120, 780)
	if !tester.HasText("来源已变化，草稿已保留。请比较当前来源后再重新载入。") {
		t.Fatal(tester.Texts())
	}
	if a.editor.Digest != "one" || a.editor.JSON != `{"command":"user draft"}` {
		t.Fatal("source replaced draft")
	}
	tester.SetDark(true)
	if directory := os.Getenv("CONNECTOR_UI_SNAPSHOTS"); directory != "" {
		saveView(t, tester, filepath.Join(directory, "resources-dark.png"))
		tester.SetDark(false)
		saveView(t, tester, filepath.Join(directory, "resources-light.png"))
		tester.SetSize(900, 640)
		saveView(t, tester, filepath.Join(directory, "resources-small.png"))
	}
}

func TestSkillEditorPreservesBinaryFiles(t *testing.T) {
	a := testApp(t)
	files := map[string]string{"SKILL.md": base64.StdEncoding.EncodeToString([]byte("中文说明")), "image.bin": base64.StdEncoding.EncodeToString([]byte{0xff, 0xfe, 0})}
	content, err := json.Marshal(files)
	if err != nil {
		t.Fatal(err)
	}
	r := model.Resource{ID: "skill", Kind: "skill", Name: "示例 Skill", Digest: "one", Content: content}
	a.state.Resources[r.ID], a.page = r, "Skills"
	a.selectResource(r)
	a.editor.File = "image.bin"
	tester := ui.NewTester(a.view, 1120, 780)
	if !tester.HasText("二进制文件，可通过导入文件替换；保存其他修改时会保留原始内容。") {
		t.Fatal(tester.Texts())
	}
	if a.editor.Files["image.bin"] != files["image.bin"] {
		t.Fatal("binary content changed")
	}
}

func saveView(t *testing.T, tester *ui.Tester, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := png.Encode(file, tester.Image()); err != nil {
		t.Fatal(err)
	}
}
