package planimage

// The board drawing of the installation manual (3e, D421): every row of
// DIN rail as a band at a fixed scale per TE, its modules as boxes with
// their position (D1, D2, …), label and width, the row's capacity marked
// and an overflow beyond it shaded red.

import (
	"image"
	"image/color"
	"image/draw"
	"math"
	"strconv"

	"golang.org/x/image/font"
)

// Board is a board to draw.
type Board struct {
	Rows []BoardRow
}

// BoardRow is a row of DIN rail.
type BoardRow struct {
	Name       string // e.g. "Row 1"
	CapacityTE float64
	Modules    []BoardModule
}

// BoardModule is a module on a row.
type BoardModule struct {
	OffsetTE, WidthTE float64
	Position          string // e.g. "D1"
	Label             string
	Color             color.RGBA // the system's badge colour; zero: grey
	Existing          bool
}

// Board drawing scale: pixels per TE (17.5 mm ≈ 48 px at about 70 dpi;
// documents print it at most 25 cm wide) and per row.
const (
	boardTE      = 48.0
	boardRowH    = 150.0
	boardMargin  = 24.0
	boardNameW   = 90.0
	boardMinCols = 12.0
)

var (
	boardRail     = color.RGBA{0x94, 0xa3, 0xb8, 0xff}
	boardFree     = color.RGBA{0xf1, 0xf5, 0xf9, 0xff}
	boardOverflow = color.NRGBA{0xdc, 0x26, 0x26, 0x50}
	boardGrey     = color.RGBA{0x64, 0x74, 0x8b, 0xff}
)

// RenderBoard draws a board.
func RenderBoard(b Board) *image.RGBA {
	cols := boardMinCols
	for _, r := range b.Rows {
		cols = math.Max(cols, r.CapacityTE)
		for _, m := range r.Modules {
			cols = math.Max(cols, m.OffsetTE+math.Max(m.WidthTE, 1))
		}
	}
	w := int(math.Ceil(2*boardMargin + boardNameW + cols*boardTE))
	h := int(math.Ceil(2*boardMargin + float64(max(len(b.Rows), 1))*boardRowH))
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(out, out.Bounds(), image.NewUniform(halo), image.Point{}, draw.Src)
	r := &renderer{dst: out, s: 1, unit: 1, font: 1.6}
	rect := func(x0, y0, x1, y1 float64) [][2]float64 {
		return [][2]float64{{x0, y0}, {x1, y0}, {x1, y1}, {x0, y1}}
	}
	for i, row := range b.Rows {
		top := boardMargin + float64(i)*boardRowH
		left := boardMargin + boardNameW
		r.plainText(row.Name, boardMargin+boardNameW/2-6, top+boardRowH/2, r.faceOf(true, 11*r.font), ink)
		// The rail's capacity as a light band with TE ticks.
		capW := row.CapacityTE * boardTE
		r.polygon(rect(left, top+12, left+capW, top+boardRowH-12), image.NewUniform(boardFree))
		r.polygon(rect(left, top+boardRowH/2-5, left+capW, top+boardRowH/2+5), image.NewUniform(boardRail))
		for te := 0.0; te <= row.CapacityTE+1e-9; te++ {
			x := left + te*boardTE
			r.polygon(rect(x-0.5, top+12, x+0.5, top+20), image.NewUniform(boardRail))
		}
		r.stroke(rect(left, top+12, left+capW, top+boardRowH-12), 1.5, boardRail)
		for _, m := range row.Modules {
			wd := math.Max(m.WidthTE, 1)
			x0, x1 := left+m.OffsetTE*boardTE+2, left+(m.OffsetTE+wd)*boardTE-2
			y0, y1 := top+22, top+boardRowH-22
			c := m.Color
			if c.A == 0 {
				c = boardGrey
			}
			r.polygon(rect(x0, y0, x1, y1), image.NewUniform(halo))
			r.polygon(rect(x0, y0, x1, y1), image.NewUniform(color.NRGBA{c.R, c.G, c.B, 0x30}))
			if m.Existing {
				r.polygon(rect(x0, y0, x1, y1), hatchImage{period: 8, width: 2})
			}
			r.stroke(rect(x0, y0, x1, y1), 2, c)
			cx := (x0 + x1) / 2
			r.plainText(m.Position, cx, y0+16, r.faceOf(true, 11*r.font), ink)
			if label := fit(r, m.Label, x1-x0-6, 9*r.font); label != "" {
				r.plainText(label, cx, (y0+y1)/2+4, r.faceOf(false, 9*r.font), ink)
			}
			r.plainText(trimTE(wd)+" TE", cx, y1-14, r.faceOf(false, 8*r.font), boardGrey)
			if m.OffsetTE+wd > row.CapacityTE+1e-9 {
				over := math.Max(left+row.CapacityTE*boardTE, x0)
				r.polygon(rect(over, y0, x1, y1), image.NewUniform(boardOverflow))
			}
		}
	}
	return out
}

// fit shortens s with "…" until it is at most width pixels wide.
func fit(r *renderer, s string, width, size float64) string {
	face := r.faceOf(false, size)
	rs := []rune(s)
	for len(rs) > 0 {
		t := string(rs)
		if len(rs) < len([]rune(s)) {
			t += "…"
		}
		if float64(font.MeasureString(face, t).Ceil()) <= width {
			return t
		}
		rs = rs[:len(rs)-1]
	}
	return ""
}

func trimTE(v float64) string {
	return strconv.FormatFloat(math.Round(v*10)/10, 'f', -1, 64)
}
