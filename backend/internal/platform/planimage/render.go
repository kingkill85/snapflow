// Package planimage draws a floorplan as an image on the server, for
// documents (proposals, spec 2d): the plan image, zones filled with their
// colour and opacity with an outline, placements as their variant images
// fitted ("contain") into their rotated boxes with labels, existing devices
// hatched, and zone names with a halo above everything (D221, D224). Line
// widths and text sizes follow the editor's PNG export (D217): one "screen
// pixel" is max(1, longest image side / 1200) image pixels. Text uses the
// embedded Go fonts.
package planimage

import (
	"image"
	"image/color"
	"image/draw"
	"math"
	"slices"
	"sync"

	xdraw "golang.org/x/image/draw"
	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/f64"
	"golang.org/x/image/math/fixed"
	"golang.org/x/image/vector"
)

// Plan is what is drawn; coordinates are pixels of Background.
type Plan struct {
	Background image.Image
	// Size is the pixel size the coordinates refer to when Background was
	// scaled down already (zero: Background's own size).
	Size       image.Point
	Zones      []Zone
	Placements []Placement
	// Symbols are need (load) symbols: a numbered circle (3e).
	Symbols []Symbol
	// TextScale enlarges labels and zone names (0 or 1: the editor's size);
	// documents print plans small, so they use more (D271).
	TextScale float64
}

// Zone is a polygon with a fill.
type Zone struct {
	Name    string
	Color   color.RGBA // opaque colour
	Opacity float64    // 0-1 of the fill
	Points  [][2]float64
}

// Placement is a placed device.
type Placement struct {
	X, Y, Width, Height float64 // centre and box size
	Rotation            float64 // degrees clockwise
	// Image is the variant image; nil draws a box in Color.
	Image    image.Image
	Color    color.RGBA
	Label    string
	Existing bool
}

// Symbol is a need's load symbol: a filled circle with a short text (its
// number in the document's tables).
type Symbol struct {
	X, Y  float64
	Text  string
	Color color.RGBA // opaque; zero: ink
}

// Paper colours (the light theme's, D221).
var (
	ink   = color.RGBA{0x1f, 0x29, 0x37, 0xff}
	halo  = color.RGBA{0xff, 0xff, 0xff, 0xff}
	hatch = color.RGBA{0x47, 0x55, 0x69, 0xc0}
)

// Render draws p at most maxSide pixels on the long side (the plan image's
// own size when smaller; 0: no limit).
func Render(p Plan) *image.RGBA { return RenderMax(p, 0) }

// RenderMax is Render scaled down to at most maxSide pixels on the long side.
func RenderMax(p Plan, maxSide int) *image.RGBA {
	b := p.Background.Bounds()
	w, h := float64(b.Dx()), float64(b.Dy())
	if p.Size.X > 0 && p.Size.Y > 0 {
		w, h = float64(p.Size.X), float64(p.Size.Y)
	}
	s := 1.0
	if long := math.Max(w, h); maxSide > 0 && long > float64(maxSide) {
		s = float64(maxSide) / long
	}
	out := image.NewRGBA(image.Rect(0, 0, max(1, int(math.Round(w*s))), max(1, int(math.Round(h*s)))))
	draw.Draw(out, out.Bounds(), image.NewUniform(halo), image.Point{}, draw.Src)
	xdraw.CatmullRom.Scale(out, out.Bounds(), p.Background, b, draw.Over, nil)

	unit := math.Max(1, math.Max(w, h)/1200) * s // one screen pixel in output pixels
	ts := p.TextScale
	if ts <= 0 {
		ts = 1
	}
	r := &renderer{dst: out, s: s, unit: unit, font: unit * ts}
	for _, z := range p.Zones {
		r.zone(z)
	}
	for _, pl := range p.Placements {
		r.placement(pl)
	}
	// Labels keep clear of the zone names (drawn later, on top).
	for _, z := range p.Zones {
		if box, ok := r.zoneNameBox(z); ok {
			r.labels = append(r.labels, box)
		}
	}
	for _, pl := range p.Placements {
		if pl.Label != "" {
			r.label(pl)
		}
	}
	for _, sy := range p.Symbols {
		r.symbol(sy)
	}
	for _, z := range p.Zones {
		r.zoneName(z)
	}
	return out
}

// symbol draws a numbered circle of 9 screen pixels radius (× TextScale).
func (r *renderer) symbol(sy Symbol) {
	c := sy.Color
	if c.A == 0 {
		c = ink
	}
	rad := 9 * r.font
	cx, cy := sy.X*r.s, sy.Y*r.s
	pts := make([][2]float64, 0, 24)
	for i := range 24 {
		sin, cos := math.Sincos(float64(i) * 2 * math.Pi / 24)
		pts = append(pts, [2]float64{cx + rad*cos, cy + rad*sin})
	}
	r.polygon(pts, image.NewUniform(c))
	r.stroke(pts, r.unit, halo)
	if sy.Text != "" {
		face := r.faceOf(true, 10*r.font)
		r.plainText(sy.Text, cx, cy, face, halo)
	}
}

// plainText draws s centred on (x, y) in c without a halo.
func (r *renderer) plainText(s string, x, y float64, face font.Face, c color.Color) {
	m := face.Metrics()
	width := font.MeasureString(face, s)
	height := float64(m.Ascent+m.Descent) / 64
	baseline := y - height/2 + float64(m.Ascent)/64
	d := &font.Drawer{Dst: r.dst, Face: face, Src: image.NewUniform(c)}
	d.Dot = fixed.Point26_6{X: fixed.Int26_6((x - float64(width)/64/2) * 64), Y: fixed.Int26_6(baseline * 64)}
	d.DrawString(s)
}

type renderer struct {
	// labels are the boxes of the labels drawn so far (collisions).
	labels []rect
	dst    *image.RGBA
	s      float64
	unit   float64
	font   float64 // unit × TextScale, for font sizes
	faces  map[faceKey]font.Face
}

func (r *renderer) polygon(pts [][2]float64, src image.Image) {
	if len(pts) < 3 {
		return
	}
	b := r.dst.Bounds()
	z := vector.NewRasterizer(b.Dx(), b.Dy())
	z.MoveTo(float32(pts[0][0]), float32(pts[0][1]))
	for _, p := range pts[1:] {
		z.LineTo(float32(p[0]), float32(p[1]))
	}
	z.ClosePath()
	z.Draw(r.dst, b, src, image.Point{})
}

// stroke draws the closed outline of pts with width wd (output pixels).
func (r *renderer) stroke(pts [][2]float64, wd float64, c color.Color) {
	src := image.NewUniform(c)
	for i := range pts {
		a, b := pts[i], pts[(i+1)%len(pts)]
		dx, dy := b[0]-a[0], b[1]-a[1]
		l := math.Hypot(dx, dy)
		if l == 0 {
			continue
		}
		nx, ny := -dy/l*wd/2, dx/l*wd/2
		r.polygon([][2]float64{{a[0] + nx, a[1] + ny}, {b[0] + nx, b[1] + ny}, {b[0] - nx, b[1] - ny}, {a[0] - nx, a[1] - ny}}, src)
	}
}

func (r *renderer) scaled(pts [][2]float64) [][2]float64 {
	out := make([][2]float64, len(pts))
	for i, p := range pts {
		out[i] = [2]float64{p[0] * r.s, p[1] * r.s}
	}
	return out
}

func (r *renderer) zone(z Zone) {
	pts := r.scaled(z.Points)
	op := math.Min(math.Max(z.Opacity, 0), 1)
	fill := color.NRGBA{z.Color.R, z.Color.G, z.Color.B, uint8(math.Round(op * 255))}
	r.polygon(pts, image.NewUniform(fill))
	r.stroke(pts, 2*r.unit, color.RGBA{z.Color.R, z.Color.G, z.Color.B, 0xff})
}

// corners of a placement's rotated box in output pixels.
func (r *renderer) corners(p Placement) [][2]float64 {
	cx, cy := p.X*r.s, p.Y*r.s
	hw, hh := p.Width*r.s/2, p.Height*r.s/2
	sin, cos := math.Sincos(p.Rotation * math.Pi / 180)
	out := make([][2]float64, 0, 4)
	for _, c := range [][2]float64{{-hw, -hh}, {hw, -hh}, {hw, hh}, {-hw, hh}} {
		out = append(out, [2]float64{cx + c[0]*cos - c[1]*sin, cy + c[0]*sin + c[1]*cos})
	}
	return out
}

func (r *renderer) placement(p Placement) {
	if p.Width <= 0 || p.Height <= 0 {
		return
	}
	if p.Image != nil && !p.Image.Bounds().Empty() {
		ib := p.Image.Bounds()
		iw, ih := float64(ib.Dx()), float64(ib.Dy())
		k := math.Min(p.Width/iw, p.Height/ih) * r.s
		sin, cos := math.Sincos(p.Rotation * math.Pi / 180)
		icx, icy := float64(ib.Min.X)+iw/2, float64(ib.Min.Y)+ih/2
		a, bb := k*cos, -k*sin
		d, e := k*sin, k*cos
		cx, cy := p.X*r.s, p.Y*r.s
		m := f64.Aff3{a, bb, cx - (a*icx + bb*icy), d, e, cy - (d*icx + e*icy)}
		xdraw.ApproxBiLinear.Transform(r.dst, m, p.Image, ib, draw.Over, nil)
	} else {
		c := p.Color
		if c.A == 0 {
			c = ink
		}
		r.polygon(r.corners(p), image.NewUniform(color.NRGBA{c.R, c.G, c.B, 0x80}))
		r.stroke(r.corners(p), r.unit, c)
	}
	if p.Existing {
		r.polygon(r.corners(p), hatchImage{period: math.Max(4, 6*r.unit), width: math.Max(1, 1.5*r.unit)})
		r.stroke(r.corners(p), r.unit, hatch)
	}
}

// hatchImage is diagonal stripes, transparent between them.
type hatchImage struct{ period, width float64 }

func (hatchImage) ColorModel() color.Model { return color.RGBAModel }
func (hatchImage) Bounds() image.Rectangle {
	return image.Rect(-1e9, -1e9, 1e9, 1e9)
}

func (h hatchImage) At(x, y int) color.Color {
	if math.Mod(float64(x+y)+1e6*h.period, h.period) < h.width {
		return hatch
	}
	return color.RGBA{}
}

// rect is a box in output pixels.
type rect struct{ x0, y0, x1, y1 float64 }

func (a rect) overlaps(b rect) bool { return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1 }

// label draws a placement's label below its box, else above, right or
// left of it where it does not overlap a label drawn before (below when
// every side is taken).
func (r *renderer) label(p Placement) {
	cs := r.corners(p)
	minX, minY, maxX, maxY := cs[0][0], cs[0][1], cs[0][0], cs[0][1]
	for _, c := range cs {
		minX, maxX = math.Min(minX, c[0]), math.Max(maxX, c[0])
		minY, maxY = math.Min(minY, c[1]), math.Max(maxY, c[1])
	}
	face := r.faceOf(false, 11*r.font)
	m := face.Metrics()
	w := float64(font.MeasureString(face, p.Label)) / 64
	h := float64(m.Ascent+m.Descent) / 64
	gap := 2 * r.unit
	cx, cy := p.X*r.s, p.Y*r.s
	// Candidate centres x and tops y.
	cands := [][2]float64{
		{cx, maxY + gap},
		{cx, minY - gap - h},
		{maxX + gap + w/2, cy - h/2},
		{minX - gap - w/2, cy - h/2},
	}
	pick := cands[0]
	for _, c := range cands {
		box := rect{c[0] - w/2, c[1], c[0] + w/2, c[1] + h}
		if !slices.ContainsFunc(r.labels, box.overlaps) {
			pick = c
			break
		}
	}
	r.labels = append(r.labels, rect{pick[0] - w/2, pick[1], pick[0] + w/2, pick[1] + h})
	r.text(p.Label, pick[0], pick[1], face, false)
}

// zoneNameBox is the box of a zone's name.
func (r *renderer) zoneNameBox(z Zone) (rect, bool) {
	if z.Name == "" || len(z.Points) == 0 {
		return rect{}, false
	}
	minX, minY, maxX, maxY := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	for _, p := range z.Points {
		minX, maxX = math.Min(minX, p[0]), math.Max(maxX, p[0])
		minY, maxY = math.Min(minY, p[1]), math.Max(maxY, p[1])
	}
	face := r.faceOf(true, 13*r.font)
	m := face.Metrics()
	w := float64(font.MeasureString(face, z.Name)) / 64
	h := float64(m.Ascent+m.Descent) / 64
	cx, cy := (minX+maxX)/2*r.s, (minY+maxY)/2*r.s
	return rect{cx - w/2, cy - h/2, cx + w/2, cy + h/2}, true
}

func (r *renderer) zoneName(z Zone) {
	if z.Name == "" || len(z.Points) == 0 {
		return
	}
	// The label point: the centre of the bounding box (as the editor).
	minX, minY, maxX, maxY := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	for _, p := range z.Points {
		minX, maxX = math.Min(minX, p[0]), math.Max(maxX, p[0])
		minY, maxY = math.Min(minY, p[1]), math.Max(maxY, p[1])
	}
	face := r.faceOf(true, 13*r.font)
	r.text(z.Name, (minX+maxX)/2*r.s, (minY+maxY)/2*r.s, face, true)
}

// text draws s centred on x; top is its top edge, or its vertical centre
// when middle. A halo in the paper colour keeps it readable (D221).
func (r *renderer) text(s string, x, top float64, face font.Face, middle bool) {
	m := face.Metrics()
	width := font.MeasureString(face, s)
	asc := float64(m.Ascent) / 64
	height := float64(m.Ascent+m.Descent) / 64
	baseline := top + asc
	if middle {
		baseline = top - height/2 + asc
	}
	origin := fixed.Point26_6{X: fixed.Int26_6((x - float64(width)/64/2) * 64), Y: fixed.Int26_6(baseline * 64)}
	d := &font.Drawer{Dst: r.dst, Face: face}
	rad := math.Max(1, math.Round(2*r.unit))
	d.Src = image.NewUniform(halo)
	for dy := -rad; dy <= rad; dy++ {
		for dx := -rad; dx <= rad; dx++ {
			if dx*dx+dy*dy > rad*rad+1 {
				continue
			}
			d.Dot = origin.Add(fixed.Point26_6{X: fixed.Int26_6(dx * 64), Y: fixed.Int26_6(dy * 64)})
			d.DrawString(s)
		}
	}
	d.Src = image.NewUniform(ink)
	d.Dot = origin
	d.DrawString(s)
}

var (
	fontsOnce     sync.Once
	regular, bold *opentype.Font
)

type faceKey struct {
	bold bool
	size float64
}

// faceOf returns a face of the embedded Go fonts. Faces are not safe for
// concurrent use, so each renderer keeps its own.
func (r *renderer) faceOf(isBold bool, size float64) font.Face {
	fontsOnce.Do(func() {
		regular, _ = opentype.Parse(goregular.TTF)
		bold, _ = opentype.Parse(gobold.TTF)
	})
	size = math.Round(math.Max(size, 6)*2) / 2
	key := faceKey{isBold, size}
	if f, ok := r.faces[key]; ok {
		return f
	}
	f := regular
	if isBold {
		f = bold
	}
	face, err := opentype.NewFace(f, &opentype.FaceOptions{Size: size, DPI: 72, Hinting: font.HintingNone})
	if err != nil {
		panic(err) // the embedded fonts always parse
	}
	if r.faces == nil {
		r.faces = map[faceKey]font.Face{}
	}
	r.faces[key] = face
	return face
}
