package files

import (
	"image"
	"image/color"
	"testing"
)

// The decode budget fits the largest image an upload may hold, so no upload
// waits forever, and 16-bit images are budgeted at 8 bytes per pixel.
func TestDecodeCost(t *testing.T) {
	const mp = MaxMegapixels * 1_000_000
	for name, tc := range map[string]struct {
		cfg         image.Config
		contentType string
		orientation int
		want        int64
	}{
		"16-bit png, tall (not scaled)": {image.Config{ColorModel: color.NRGBA64Model, Width: 1600, Height: mp / 1600}, TypePNG, 1, mp*8 + mp*4},
		"cmyk jpeg, turned":             {image.Config{ColorModel: color.CMYKModel, Width: mp / 1600, Height: 1600}, TypeJPEG, 6, mp*4 + 2*mp*4},
		"photo, scaled":                 {image.Config{ColorModel: color.YCbCrModel, Width: 4000, Height: 3000}, TypeJPEG, 1, 4000*3000*3 + 1600*1200*4},
		"webp":                          {image.Config{ColorModel: color.NRGBAModel, Width: 100, Height: 100}, TypeWebP, 1, 100 * 100 * 4},
	} {
		got := decodeCost(tc.cfg, tc.contentType, tc.orientation, MaxWidth)
		if got != tc.want {
			t.Errorf("%s: cost %d, want %d", name, got, tc.want)
		}
		if got > DecodeBudget {
			t.Errorf("%s: cost %d above the budget %d", name, got, DecodeBudget)
		}
	}
}

func TestScaledSize(t *testing.T) {
	for _, tc := range []struct {
		w, h   int
		swap   bool
		ww, wh int
	}{
		{3200, 1000, false, 1600, 500},
		{1000, 3200, true, 500, 1600}, // upright 3200 wide: scaled before turning
		{1000, 3200, false, 1000, 3200},
		{1600, 20, false, 1600, 20},
	} {
		if w, h := scaledSize(tc.w, tc.h, MaxWidth, tc.swap); w != tc.ww || h != tc.wh {
			t.Errorf("%dx%d swap %v: %dx%d, want %dx%d", tc.w, tc.h, tc.swap, w, h, tc.ww, tc.wh)
		}
	}
}
