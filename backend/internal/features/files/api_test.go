package files_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kingkill85/snapflow/backend/internal/app/apptest"
	"github.com/kingkill85/snapflow/backend/internal/features/files"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/testdb"
)

func TestMain(m *testing.M) { os.Exit(testdb.Run(m)) }

type file struct {
	ID          string `json:"id"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	SHA256      string `json:"sha256"`
	URL         string `json:"url"`
}

type problem struct {
	Code   string         `json:"code"`
	Params map[string]any `json:"params"`
}

func decode[T any](t *testing.T, resp *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(resp.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %s: %v", resp.Body, err)
	}
	return v
}

// pngImage encodes a w×h PNG with a gradient and transparency.
func pngImage(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.NRGBA{R: uint8(x), G: uint8(y), B: 200, A: uint8(x + y)}) //nolint:gosec // wraps on purpose
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// noisyPNG is a PNG that does not compress, so cutting it loses pixel data.
func noisyPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewGray(image.Rect(0, 0, w, h))
	seed := uint32(1)
	for i := range img.Pix {
		seed = seed*1664525 + 1013904223
		img.Pix[i] = uint8(seed >> 24)
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func jpegImage(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 100, A: 255}) //nolint:gosec // wraps on purpose
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// webpImage is a 1×1 lossless WebP.
func webpImage(t *testing.T) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// upload posts data as the multipart field "file". It bypasses humatest's
// request logging, which would dump megabytes of image data.
func upload(t *testing.T, api *apptest.API, cookie string, data []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, err := w.CreateFormFile("file", "photo.png") // the name and declared type are ignored
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/files", &body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	if cookie != "" {
		req.Header.Set("Cookie", cookie[len("Cookie: "):])
	}
	resp := httptest.NewRecorder()
	api.Adapter().ServeHTTP(resp, req)
	return resp
}

func mustUpload(t *testing.T, api *apptest.API, data []byte) file {
	t.Helper()
	resp := upload(t, api, api.Admin.Cookie, data)
	if resp.Code != http.StatusCreated {
		t.Fatalf("upload: got %d: %s", resp.Code, resp.Body)
	}
	return decode[file](t, resp)
}

func TestUploadAndDownload(t *testing.T) {
	api := apptest.New(t)
	data := pngImage(t, 10, 5)
	f := mustUpload(t, api, data)
	// Stored content-addressed under the storage directory: re-encoded
	// (always, D58), with the same pixels.
	stored, err := os.ReadFile(filepath.Join(api.StorageDir, f.SHA256[0:2], f.SHA256[2:4], f.SHA256))
	if err != nil {
		t.Fatalf("stored file: %v", err)
	}
	sum := sha256.Sum256(stored)
	want := file{
		ID: f.ID, ContentType: "image/png", Size: int64(len(stored)), Width: 10, Height: 5,
		SHA256: hex.EncodeToString(sum[:]), URL: "/api/files/" + f.ID,
	}
	if f != want {
		t.Errorf("upload: %+v\nwant %+v", f, want)
	}
	samePixels(t, data, stored)

	partner := api.NewTenant("Partner")
	user := api.NewUser(partner, auth.RoleUser)
	for name, cookie := range map[string]string{"admin": api.Admin.Cookie, "partner user": user.Cookie} {
		resp := api.Get(f.URL, cookie)
		if resp.Code != http.StatusOK || !bytes.Equal(resp.Body.Bytes(), stored) {
			t.Fatalf("%s download: got %d", name, resp.Code)
		}
		h := resp.Header()
		for k, v := range map[string]string{
			"Content-Type":           "image/png",
			"Cache-Control":          "private, max-age=31536000, immutable",
			"ETag":                   `"` + f.SHA256 + `"`,
			"X-Content-Type-Options": "nosniff",
		} {
			if h.Get(k) != v {
				t.Errorf("%s: header %s = %q, want %q", name, k, h.Get(k), v)
			}
		}
	}

	resp := api.Get(f.URL, api.Admin.Cookie, `If-None-Match: "`+f.SHA256+`"`)
	if resp.Code != http.StatusNotModified || resp.Body.Len() != 0 {
		t.Errorf("if-none-match: got %d", resp.Code)
	}
	if resp := api.Get(f.URL, api.Admin.Cookie, `If-None-Match: "other"`); resp.Code != http.StatusOK {
		t.Errorf("other etag: got %d", resp.Code)
	}

	if resp := api.Get(f.URL); resp.Code != http.StatusUnauthorized {
		t.Errorf("anonymous download: got %d", resp.Code)
	}
	resp = api.Get("/api/files/00000000-0000-0000-0000-000000000001", api.Admin.Cookie)
	if resp.Code != http.StatusNotFound || decode[problem](t, resp).Code != "file.not_found" {
		t.Errorf("missing file: got %d: %s", resp.Code, resp.Body)
	}
}

func TestUploadPermissions(t *testing.T) {
	api := apptest.New(t)
	partner := api.NewTenant("Partner")
	data := pngImage(t, 2, 2)
	for _, role := range []auth.Role{auth.RoleUser, auth.RoleTenantAdmin} {
		s := api.NewUser(partner, role)
		if resp := upload(t, api, s.Cookie, data); resp.Code != http.StatusForbidden {
			t.Errorf("%s upload: got %d", role, resp.Code)
		}
	}
	if resp := upload(t, api, "", data); resp.Code != http.StatusUnauthorized {
		t.Errorf("anonymous upload: got %d", resp.Code)
	}
}

func TestUploadTypes(t *testing.T) {
	api := apptest.New(t)
	for name, tc := range map[string]struct {
		data []byte
		want string
	}{
		"jpeg": {jpegImage(t, 4, 3), "image/jpeg"},
		"png":  {pngImage(t, 4, 3), "image/png"},
		"webp": {webpImage(t), "image/webp"},
	} {
		if f := mustUpload(t, api, tc.data); f.ContentType != tc.want || f.Width == 0 || f.Height == 0 {
			t.Errorf("%s: %+v", name, f)
		}
	}

	gif := []byte("GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00!\xf9\x04\x00\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;")
	for name, data := range map[string][]byte{
		"gif":                    gif,
		"text":                   []byte("hello, I am a PNG"),
		"html":                   []byte("<html><script>alert(1)</script></html>"),
		"empty":                  {},
		"png magic, no image":    append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 100)...),
		"jpeg magic, no image":   append([]byte{0xff, 0xd8, 0xff, 0xe0}, make([]byte, 100)...),
		"webp header, no image":  []byte("RIFF\x10\x00\x00\x00WEBPVP8 \x00\x00\x00\x00"),
		"png header, cut pixels": noisyPNG(t, 2000, 50)[:5000],
		"small png, cut pixels":  noisyPNG(t, 100, 100)[:3000],
	} {
		resp := upload(t, api, api.Admin.Cookie, data)
		if resp.Code != http.StatusUnsupportedMediaType || decode[problem](t, resp).Code != "file.type" {
			t.Errorf("%s: got %d: %s", name, resp.Code, resp.Body)
		}
	}
}

func TestUploadTooLarge(t *testing.T) {
	api := apptest.New(t)
	// Just over the limit: the request passes the body cap, the file does not.
	data := append(pngImage(t, 2, 2), make([]byte, files.MaxSize)...)
	resp := upload(t, api, api.Admin.Cookie, data)
	p := decode[problem](t, resp)
	if resp.Code != http.StatusRequestEntityTooLarge || p.Code != "file.too_large" || p.Params["maxMb"] != 10.0 {
		t.Errorf("over the limit: got %d: %s", resp.Code, resp.Body)
	}
	// Far over: refused from Content-Length before reading.
	resp = upload(t, api, api.Admin.Cookie, make([]byte, files.MaxSize+1<<20))
	if resp.Code != http.StatusRequestEntityTooLarge || decode[problem](t, resp).Code != "file.too_large" {
		t.Errorf("far over the limit: got %d: %s", resp.Code, resp.Body)
	}
	// Exactly at the limit is accepted (a valid PNG padded with trailing
	// bytes, which re-encoding drops).
	data = pngImage(t, 2, 2)
	data = append(data, make([]byte, files.MaxSize-len(data))...)
	if f := mustUpload(t, api, data); f.Width != 2 || f.Size >= 1000 {
		t.Errorf("at the limit: %+v", f)
	}
}

// A chunked body announces no size: it is cut off at the cap while the
// multipart form is read, and that is file.too_large too, not a form error.
func TestUploadTooLargeChunked(t *testing.T) {
	api := apptest.New(t)
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, err := w.CreateFormFile("file", "big.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write(append(pngImage(t, 2, 2), make([]byte, files.MaxSize+1<<20)...))
	_ = w.Close()
	// Hide the length: httptest would set ContentLength from a *bytes.Buffer.
	req := httptest.NewRequest(http.MethodPost, "/api/files", io.MultiReader(&body))
	req.ContentLength = -1
	req.TransferEncoding = []string{"chunked"}
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("Cookie", api.Admin.Cookie[len("Cookie: "):])
	resp := httptest.NewRecorder()
	api.Adapter().ServeHTTP(resp, req)
	if p := decode[problem](t, resp); resp.Code != http.StatusRequestEntityTooLarge || p.Code != "file.too_large" {
		t.Errorf("chunked: got %d: %s", resp.Code, resp.Body)
	}
}

func TestDedup(t *testing.T) {
	api := apptest.New(t)
	data := pngImage(t, 8, 8)
	first := mustUpload(t, api, data)
	second := mustUpload(t, api, data)
	if first.ID != second.ID {
		t.Errorf("same bytes gave two files: %s, %s", first.ID, second.ID)
	}
	if other := mustUpload(t, api, pngImage(t, 8, 9)); other.ID == first.ID {
		t.Error("different bytes gave the same file")
	}
	// Downscaling is deterministic, so a large image deduplicates too.
	big := jpegImage(t, 2000, 100)
	if a, b := mustUpload(t, api, big), mustUpload(t, api, big); a.ID != b.ID {
		t.Errorf("downscaled uploads differ: %s, %s", a.ID, b.ID)
	}
}

func TestDownscale(t *testing.T) {
	api := apptest.New(t)
	for name, tc := range map[string]struct {
		data         []byte
		contentType  string
		wantW, wantH int
	}{
		"wide png":      {pngImage(t, 3200, 1000), "image/png", 1600, 500},
		"wide jpeg":     {jpegImage(t, 2000, 1500), "image/jpeg", 1600, 1200},
		"rounding":      {pngImage(t, 1601, 3), "image/png", 1600, 3},
		"exactly 1600":  {pngImage(t, 1600, 20), "image/png", 1600, 20},
		"tall, narrow":  {jpegImage(t, 100, 2500), "image/jpeg", 100, 2500},
		"thin and wide": {pngImage(t, 4000, 1), "image/png", 1600, 1},
	} {
		f := mustUpload(t, api, tc.data)
		if f.ContentType != tc.contentType || f.Width != tc.wantW || f.Height != tc.wantH {
			t.Errorf("%s: %+v", name, f)
			continue
		}
		// The stored bytes are what the metadata says.
		resp := api.Get(f.URL, api.Admin.Cookie)
		cfg, format, err := image.DecodeConfig(bytes.NewReader(resp.Body.Bytes()))
		if err != nil || cfg.Width != tc.wantW || cfg.Height != tc.wantH || "image/"+format != tc.contentType || int64(resp.Body.Len()) != f.Size {
			t.Errorf("%s: stored %dx%d %s (%v)", name, cfg.Width, cfg.Height, format, err)
		}
	}
	// PNG keeps transparency.
	f := mustUpload(t, api, pngImage(t, 3200, 10))
	img, err := png.Decode(bytes.NewReader(api.Get(f.URL, api.Admin.Cookie).Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, a := img.At(0, 0).RGBA(); a == 0xffff {
		t.Error("transparency lost")
	}
}

// withOrientation inserts an EXIF APP1 segment with the orientation tag
// after a JPEG's SOI marker.
func withOrientation(jpg []byte, orientation byte) []byte {
	tiff := []byte{
		'M', 'M', 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big endian, IFD0 at offset 8
		0x00, 0x01, // one entry
		0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, // orientation, SHORT, count 1
		0x00, orientation, 0x00, 0x00, // value
		0x00, 0x00, 0x00, 0x00, // no next IFD
	}
	payload := append([]byte("Exif\x00\x00"), tiff...)
	seg := []byte{0xff, 0xe1, byte((len(payload) + 2) >> 8), byte(len(payload) + 2)}
	out := append([]byte{}, jpg[:2]...)
	out = append(out, seg...)
	out = append(out, payload...)
	return append(out, jpg[2:]...)
}

func TestOrientation(t *testing.T) {
	api := apptest.New(t)
	// 40×20: left half red, right half blue.
	img := image.NewRGBA(image.Rect(0, 0, 40, 20))
	for y := range 20 {
		for x := range 40 {
			c := color.RGBA{R: 255, A: 255}
			if x >= 20 {
				c = color.RGBA{B: 255, A: 255}
			}
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	red := func(c color.Color) bool { r, _, b, _ := c.RGBA(); return r > b }

	// Upright: same size (re-encoded, without the EXIF segment).
	upright := withOrientation(buf.Bytes(), 1)
	if f := mustUpload(t, api, upright); f.Width != 40 || f.Height != 20 {
		t.Errorf("upright: %+v", f)
	}
	// 6 = turn 90° clockwise: the left (red) half ends up on top.
	f := mustUpload(t, api, withOrientation(buf.Bytes(), 6))
	if f.Width != 20 || f.Height != 40 {
		t.Fatalf("rotated: %+v", f)
	}
	out, err := jpeg.Decode(bytes.NewReader(api.Get(f.URL, api.Admin.Cookie).Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if !red(out.At(10, 5)) || red(out.At(10, 35)) {
		t.Error("rotation 6: wrong pixels")
	}
	// 8 = turn 90° counter-clockwise: the right (blue) half ends up on top.
	f = mustUpload(t, api, withOrientation(buf.Bytes(), 8))
	out, err = jpeg.Decode(bytes.NewReader(api.Get(f.URL, api.Admin.Cookie).Body.Bytes()))
	if err != nil || f.Width != 20 || red(out.At(10, 5)) || !red(out.At(10, 35)) {
		t.Errorf("rotation 8: %+v %v", f, err)
	}
	// 3 = upside down: red on the right.
	f = mustUpload(t, api, withOrientation(buf.Bytes(), 3))
	out, err = jpeg.Decode(bytes.NewReader(api.Get(f.URL, api.Admin.Cookie).Body.Bytes()))
	if err != nil || f.Width != 40 || red(out.At(5, 10)) || !red(out.At(35, 10)) {
		t.Errorf("rotation 3: %+v %v", f, err)
	}
	// Scaled first, then turned: a 1000×3400 photo with orientation 6 is
	// 3400 px wide upright, so it is stored 1600 px wide.
	f = mustUpload(t, api, withOrientation(jpegImage(t, 1000, 3400), 6))
	if f.Width != 1600 || f.Height != 471 {
		t.Errorf("rotated and scaled: %+v", f)
	}
}

func TestTooManyPixels(t *testing.T) {
	api := apptest.New(t)
	// One pixel row above 25 megapixels: refused before decoding.
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewGray(image.Rect(0, 0, 5000, 5001))); err != nil {
		t.Fatal(err)
	}
	resp := upload(t, api, api.Admin.Cookie, buf.Bytes())
	p := decode[problem](t, resp)
	if resp.Code != http.StatusUnprocessableEntity || p.Code != "file.too_many_pixels" || p.Params["megapixels"] != 25.0 {
		t.Errorf("got %d: %s", resp.Code, resp.Body)
	}
	// Exactly 25 megapixels, 16 bits per sample: accepted, stored with 8.
	buf.Reset()
	if err := png.Encode(&buf, image.NewGray16(image.Rect(0, 0, 5000, 5000))); err != nil {
		t.Fatal(err)
	}
	f := mustUpload(t, api, buf.Bytes())
	stored := api.Get(f.URL, api.Admin.Cookie).Body.Bytes()
	if f.Width != 1600 || f.Height != 1600 || pngBitDepth(stored) != 8 {
		t.Errorf("25 MP 16-bit: %+v, bit depth %d", f, pngBitDepth(stored))
	}
}

// pngBitDepth reads the bit depth from a PNG's IHDR chunk.
func pngBitDepth(data []byte) int {
	if len(data) < 25 || !bytes.Equal(data[12:16], []byte("IHDR")) {
		return 0
	}
	return int(data[24])
}

// A 16-bit PNG (with transparency) is stored with 8 bits per sample and the
// same colours.
func TestSixteenBitPNG(t *testing.T) {
	api := apptest.New(t)
	img := image.NewNRGBA64(image.Rect(0, 0, 30, 20))
	for y := range 20 {
		for x := range 30 {
			img.Set(x, y, color.NRGBA64{R: uint16(x) * 2000, G: uint16(y) * 3000, B: 0xffff, A: 0x8000}) //nolint:gosec // small
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	if pngBitDepth(buf.Bytes()) != 16 {
		t.Fatal("test image is not 16-bit")
	}
	f := mustUpload(t, api, buf.Bytes())
	stored := api.Get(f.URL, api.Admin.Cookie).Body.Bytes()
	if f.Width != 30 || f.Height != 20 || pngBitDepth(stored) != 8 {
		t.Fatalf("stored: %+v, bit depth %d", f, pngBitDepth(stored))
	}
	out, err := png.Decode(bytes.NewReader(stored))
	if err != nil {
		t.Fatal(err)
	}
	got := color.NRGBAModel.Convert(out.At(10, 5)).(color.NRGBA)
	want := color.NRGBAModel.Convert(img.At(10, 5)).(color.NRGBA)
	if diff(got.R, want.R) > 1 || diff(got.G, want.G) > 1 || diff(got.B, want.B) > 1 || diff(got.A, want.A) > 1 {
		t.Errorf("pixel %v, want %v", got, want)
	}
}

func diff(a, b uint8) int {
	if a > b {
		return int(a - b)
	}
	return int(b - a)
}

// samePixels checks that two PNGs hold the same 8-bit pixels.
func samePixels(t *testing.T, a, b []byte) {
	t.Helper()
	ia, err := png.Decode(bytes.NewReader(a))
	if err != nil {
		t.Fatal(err)
	}
	ib, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	if ia.Bounds() != ib.Bounds() {
		t.Fatalf("bounds %v, %v", ia.Bounds(), ib.Bounds())
	}
	for y := ia.Bounds().Min.Y; y < ia.Bounds().Max.Y; y++ {
		for x := ia.Bounds().Min.X; x < ia.Bounds().Max.X; x++ {
			if color.NRGBAModel.Convert(ia.At(x, y)) != color.NRGBAModel.Convert(ib.At(x, y)) {
				t.Fatalf("pixel %d,%d differs", x, y)
			}
		}
	}
}

// Every stored JPEG is re-encoded, so no EXIF (GPS position, camera,
// thumbnail) survives, also when nothing needs scaling or turning.
func TestJPEGMetadataStripped(t *testing.T) {
	api := apptest.New(t)
	upright := withOrientation(jpegImage(t, 40, 30), 1)
	// An EXIF segment, and a comment standing in for a GPS position.
	marked := withComment(upright, "GPS 52.5200N 13.4050E")
	f := mustUpload(t, api, marked)
	stored := api.Get(f.URL, api.Admin.Cookie).Body.Bytes()
	for _, s := range []string{"Exif", "GPS 52.5200N"} {
		if bytes.Contains(stored, []byte(s)) {
			t.Errorf("stored JPEG still contains %q", s)
		}
	}
	if f.Width != 40 || f.Height != 30 {
		t.Errorf("size: %+v", f)
	}
}

// withComment inserts a COM segment after a JPEG's SOI marker.
func withComment(jpg []byte, comment string) []byte {
	seg := []byte{0xff, 0xfe, byte((len(comment) + 2) >> 8), byte(len(comment) + 2)}
	out := append([]byte{}, jpg[:2]...)
	out = append(out, seg...)
	out = append(out, comment...)
	return append(out, jpg[2:]...)
}

// A WebP is decoded completely: a valid header with broken image data is
// refused like any other damaged image.
func TestInvalidWebP(t *testing.T) {
	api := apptest.New(t)
	data := webpImage(t)
	for i := 25; i < len(data); i++ { // the VP8L bitstream after its header
		data[i] = 0xff
	}
	resp := upload(t, api, api.Admin.Cookie, data)
	if resp.Code != http.StatusUnsupportedMediaType || decode[problem](t, resp).Code != "file.type" {
		t.Errorf("broken webp: got %d: %s", resp.Code, resp.Body)
	}
	// A valid WebP is stored as uploaded (Go has no WebP encoder).
	valid := webpImage(t)
	if f := mustUpload(t, api, valid); f.Size != int64(len(valid)) {
		t.Errorf("valid webp: %+v", f)
	}
}

// The catalog is global (D17): a user of a partner tenant downloads every
// file. Files get an owner scope before the first tenant-owned upload.
func TestDownloadAcrossTenants(t *testing.T) {
	api := apptest.New(t)
	f := mustUpload(t, api, pngImage(t, 3, 3))
	user := api.NewUser(api.NewTenant("Partner"), auth.RoleUser)
	if resp := api.Get(f.URL, user.Cookie); resp.Code != http.StatusOK {
		t.Errorf("partner download: got %d", resp.Code)
	}
}

// Contents missing on disk are an integrity error: 500, logged, and the
// response tells nothing about it.
func TestMissingContents(t *testing.T) {
	api := apptest.New(t)
	f := mustUpload(t, api, pngImage(t, 4, 4))
	if err := os.Remove(filepath.Join(api.StorageDir, f.SHA256[0:2], f.SHA256[2:4], f.SHA256)); err != nil {
		t.Fatal(err)
	}
	resp := api.Get(f.URL, api.Admin.Cookie)
	body := resp.Body.String()
	if resp.Code != http.StatusInternalServerError || decode[problem](t, resp).Code != "server.error" {
		t.Fatalf("got %d: %s", resp.Code, body)
	}
	for _, leak := range []string{f.SHA256, api.StorageDir, "no such file", "missing"} {
		if strings.Contains(body, leak) {
			t.Errorf("response reveals %q: %s", leak, body)
		}
	}
}
