// Command icons exports desktop artwork from the shared SVG mark without CGO.
package main

import (
	"bytes"
	"encoding/binary"
	"flag"
	"fmt"
	"image/png"
	"os"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo/ui"
)

func main() {
	output := flag.String("output", "internal/desktop/branding", "asset directory containing mark.svg")
	flag.Parse()
	if err := generate(*output); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func generate(directory string) error {
	mark, err := os.ReadFile(filepath.Join(directory, "mark.svg"))
	if err != nil {
		return err
	}
	// Nest the source SVG so the app and tray always use the same geometry.
	app := `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><title>MCP Platform Connector</title><rect x="32" y="32" width="448" height="448" rx="108" fill="#2864d7"/><g color="#ffffff" transform="translate(100 92) scale(13)">` + string(mark) + `</g></svg>`
	tray := `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" color="#2864d7">` + string(mark) + `</svg>`
	template := strings.ReplaceAll(tray, `color="#2864d7"`, `color="#000000"`)
	for name, svg := range map[string]string{"connector.svg": app, "tray.svg": tray, "tray-template.svg": template} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(svg+"\n"), 0644); err != nil {
			return err
		}
	}
	for _, asset := range []struct {
		name, svg string
		size      int
	}{{"connector.png", app, 512}, {"tray.png", tray, 36}, {"tray-template.png", template, 36}} {
		data, err := rasterize(asset.svg, asset.size)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(directory, asset.name), data, 0644); err != nil {
			return err
		}
	}
	if err := writeICNS(filepath.Join(directory, "connector.icns"), app); err != nil {
		return err
	}
	return writeICO(filepath.Join(directory, "connector.ico"), app)
}

func rasterize(source string, size int) ([]byte, error) {
	svg, err := ui.ParseSVG([]byte(source))
	if err != nil {
		return nil, err
	}
	img := ui.Render(func(c *ui.Context) {
		theme := *c.Theme()
		theme.Background = ui.Transparent
		c.SetTheme(&theme)
		ui.Image(c, svg).Fill()
	}, size, size, 1)
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func writeICNS(path, source string) error {
	var records bytes.Buffer
	for _, entry := range []struct {
		tag  string
		size int
	}{{"icp4", 16}, {"icp5", 32}, {"icp6", 64}, {"ic07", 128}, {"ic08", 256}, {"ic09", 512}, {"ic10", 1024}} {
		data, err := rasterize(source, entry.size)
		if err != nil {
			return err
		}
		records.WriteString(entry.tag)
		records.Write(binary.BigEndian.AppendUint32(nil, uint32(len(data)+8)))
		records.Write(data)
	}
	data := []byte("icns")
	data = binary.BigEndian.AppendUint32(data, uint32(records.Len()+8))
	return os.WriteFile(path, append(data, records.Bytes()...), 0644)
}
