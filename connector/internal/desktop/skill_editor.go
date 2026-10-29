package desktop

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

func (a *App) skillEditor(c *ui.Context, readOnly bool) {
	paths := make([]string, 0, len(a.editor.Files))
	for path := range a.editor.Files {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	ui.Text(c, "Skill 文件")
	ui.Select(c.Key("skill-file"), &a.editor.File, paths).Label("Skill 文件")
	data, err := base64.StdEncoding.DecodeString(a.editor.Files[a.editor.File])
	switch {
	case err != nil:
		ui.Text(c, "文件编码错误："+err.Error()).TextColor(c.Theme().Danger)
	case !utf8.Valid(data):
		ui.Text(c, "二进制文件，可通过导入文件替换；保存其他修改时会保留原始内容。")
	default:
		text := string(data)
		if ui.TextArea(c.Key(a.editor.File), &text).Height(260).Padding(14).Font("monospace").FontSize(13).Background(colors(c).Canvas).Label("Skill 文件内容").ReadOnly(readOnly || a.busy).Changed() {
			a.editor.Files[a.editor.File] = base64.StdEncoding.EncodeToString([]byte(text))
		}
	}
	if readOnly {
		return
	}
	ui.Collapsible(c, "管理 Skill 文件", &a.editor.FilesOpen, func() {
		ui.Column(c).Gap(12).Padding(12, 0, 0, 0).Children(func() {
			field(c, "新文件相对路径", &a.editor.NewFile)
			ui.Row(c).Gap(8).Wrap().Children(func() {
				if ui.Button(c, "新建空文件").Disabled(a.busy || a.editor.NewFile == "").Clicked() {
					a.addSkillFile()
				}
				if ui.Button(c, "导入或替换文件…").Disabled(a.busy).Clicked() {
					a.importSkillFiles()
				}
				if ui.Button(c, "从草稿移除此文件").Disabled(a.busy || a.editor.File == "").Clicked() {
					delete(a.editor.Files, a.editor.File)
					a.editor.File = "SKILL.md"
				}
			})
		})
	})
}

func (a *App) addSkillFile() {
	name := a.editor.NewFile
	if _, exists := a.editor.Files[name]; exists {
		a.error = "文件已存在，请在文件列表中选择。"
		return
	}
	if !validSkillPath(name) {
		a.error = "请输入不含上跳、反斜杠的相对文件路径。"
		return
	}
	a.editor.Files[name], a.editor.File, a.editor.NewFile = "", name, ""
}

func validSkillPath(name string) bool {
	return !strings.Contains(name, "\\") && filepath.ToSlash(name) == name && !filepath.IsAbs(name) && filepath.IsLocal(name) && name != "." && !containsParent(name)
}

func containsParent(name string) bool {
	for _, part := range strings.Split(name, "/") {
		if part == ".." || part == "" {
			return true
		}
	}
	return false
}

func (a *App) importSkillFiles() {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: a.win, Title: "导入或替换 Skill 文件", Multiple: true})
	if err != nil {
		a.error = err.Error()
		return
	}
	if len(paths) == 0 {
		return
	}
	id := a.editor.ID
	a.work(func(w *worker) error {
		files := map[string]string{}
		for _, path := range paths {
			data, err := os.ReadFile(path)
			if err != nil {
				return fmt.Errorf("读取导入文件 %s：%w", filepath.Base(path), err)
			}
			files[filepath.Base(path)] = base64.StdEncoding.EncodeToString(data)
		}
		a.win.Update(func() {
			if a.editor.ID == id {
				for name, data := range files {
					a.editor.Files[name] = data
					a.editor.File = name
				}
			} else if draft, ok := a.drafts[id]; ok {
				for name, data := range files {
					draft.Files[name] = data
				}
				a.drafts[id] = draft
			}
		})
		return nil
	})
}
