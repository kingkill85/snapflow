package planimage

import (
	"image/color"
	"testing"
)

func TestRenderBoard(t *testing.T) {
	img := RenderBoard(Board{Rows: []BoardRow{
		{Name: "Row 1", CapacityTE: 12, Modules: []BoardModule{{OffsetTE: 0, WidthTE: 4, Position: "D1", Label: "Dimmer living room"},
			{OffsetTE: 10, WidthTE: 4, Position: "D2", Color: color.RGBA{0x1f, 0x6f, 0xeb, 0xff}}}},
		{Name: "Row 2", CapacityTE: 18},
	}})
	b := img.Bounds()
	// 18 TE at 48 px plus margins and the row names; two rows of 150 px.
	if b.Dx() != int(2*boardMargin+boardNameW+18*boardTE) || b.Dy() != int(2*boardMargin+2*boardRowH) {
		t.Fatalf("size %v", b)
	}
	// The overflow beyond 12 TE of row 1 is shaded red.
	x := int(boardMargin + boardNameW + 13*boardTE)
	in := img.RGBAAt(x-2*int(boardTE), int(boardMargin+boardRowH/2+30))
	if c := img.RGBAAt(x, int(boardMargin+boardRowH/2+30)); c.R <= in.R {
		t.Errorf("overflow not red: %v", c)
	}
}
