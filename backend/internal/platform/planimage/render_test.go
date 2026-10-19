package planimage

import (
	"image"
	"image/color"
	"image/draw"
	"testing"
)

func uniform(w, h int, c color.Color) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(img, img.Bounds(), image.NewUniform(c), image.Point{}, draw.Src)
	return img
}

func near(c color.RGBA, r, g, b uint8, tol int) bool {
	d := func(a, b uint8) int {
		if a > b {
			return int(a - b)
		}
		return int(b - a)
	}
	return d(c.R, r) <= tol && d(c.G, g) <= tol && d(c.B, b) <= tol
}

func TestRender(t *testing.T) {
	white := color.RGBA{255, 255, 255, 255}
	p := Plan{
		Background: uniform(800, 600, white),
		Zones: []Zone{{Name: "Living", Color: color.RGBA{255, 0, 0, 255}, Opacity: 0.5,
			Points: [][2]float64{{20, 20}, {380, 20}, {380, 280}, {20, 280}}}},
		Placements: []Placement{
			{X: 600, Y: 150, Width: 80, Height: 40, Rotation: 90, Image: uniform(40, 20, color.RGBA{0, 0, 255, 255}), Label: "L1"},
			{X: 600, Y: 450, Width: 60, Height: 60, Color: color.RGBA{0, 160, 0, 255}, Existing: true},
		},
	}
	out := Render(p)
	if out.Bounds().Dx() != 800 || out.Bounds().Dy() != 600 {
		t.Fatalf("size %v, want 800x600", out.Bounds())
	}
	// The zone fill: half red over white.
	if c := out.RGBAAt(100, 200); !near(c, 255, 128, 128, 10) {
		t.Errorf("zone fill %v", c)
	}
	// The placement image, rotated 90° (box 80x40 → upright 40x80, image
	// contain-fitted 80x40 rotated → 40 wide, 80 high around the centre).
	if c := out.RGBAAt(600, 150); !near(c, 0, 0, 255, 20) {
		t.Errorf("placement centre %v", c)
	}
	if c := out.RGBAAt(600, 185); !near(c, 0, 0, 255, 20) {
		t.Errorf("rotated placement should reach y=185: %v", c)
	}
	if c := out.RGBAAt(635, 150); !near(c, 255, 255, 255, 5) {
		t.Errorf("rotated placement should not reach x=635: %v", c)
	}
	// The existing device is hatched: some pixels of its box are the hatch
	// colour, some are the green fill.
	hatched, plain := 0, 0
	for y := 425; y < 475; y++ {
		for x := 575; x < 625; x++ {
			c := out.RGBAAt(x, y)
			if c.R < 140 && c.G < 140 && c.B < 160 && c.R > 40 {
				hatched++
			} else {
				plain++
			}
		}
	}
	if hatched == 0 || plain == 0 {
		t.Errorf("existing device: %d hatched, %d other pixels", hatched, plain)
	}
	// The zone name is drawn: dark pixels near the zone's centre.
	dark := 0
	for y := 135; y < 165; y++ {
		for x := 170; x < 230; x++ {
			if c := out.RGBAAt(x, y); c.R < 100 && c.G < 100 {
				dark++
			}
		}
	}
	if dark == 0 {
		t.Error("the zone name is not drawn")
	}
}

func TestRenderMax(t *testing.T) {
	out := RenderMax(Plan{Background: uniform(4000, 2000, color.White)}, 2000)
	if out.Bounds().Dx() != 2000 || out.Bounds().Dy() != 1000 {
		t.Fatalf("size %v, want 2000x1000", out.Bounds())
	}
	// Not blank: the white background is drawn (not transparent).
	if c := out.RGBAAt(10, 10); c.A != 255 {
		t.Errorf("background not drawn: %v", c)
	}
}
