package branding

import (
	"bytes"
	"image/png"
	"testing"
)

func TestTemplateHasTransparentBackgroundAndMonochromeInk(t *testing.T) {
	img, err := png.Decode(bytes.NewReader(Tray(true)))
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() != 36 || img.Bounds().Dy() != 36 {
		t.Fatalf("unexpected tray dimensions: %v", img.Bounds())
	}
	ink, transparent := 0, 0
	for y := img.Bounds().Min.Y; y < img.Bounds().Max.Y; y++ {
		for x := img.Bounds().Min.X; x < img.Bounds().Max.X; x++ {
			r, g, b, a := img.At(x, y).RGBA()
			if a == 0 {
				transparent++
				continue
			}
			if r != 0 || g != 0 || b != 0 {
				t.Fatalf("template contains colored ink at %d,%d", x, y)
			}
			ink++
		}
	}
	if ink == 0 || transparent == 0 {
		t.Fatalf("template needs both ink and transparency: ink=%d transparent=%d", ink, transparent)
	}
}
