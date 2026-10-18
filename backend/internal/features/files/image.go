package files

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"image/png"
	"math"

	xdraw "golang.org/x/image/draw"
	"golang.org/x/image/webp"
)

// Image content types accepted for upload, recognised by their magic bytes.
const (
	TypeJPEG = "image/jpeg"
	TypePNG  = "image/png"
	TypeWebP = "image/webp"
)

// sniff returns the content type of data by its magic bytes, or "" if it is
// not an accepted type. The name and declared type of an upload are ignored.
func sniff(data []byte) string {
	switch {
	case bytes.HasPrefix(data, []byte{0xff, 0xd8, 0xff}):
		return TypeJPEG
	case bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")):
		return TypePNG
	case len(data) >= 12 && bytes.Equal(data[0:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")):
		return TypeWebP
	}
	return ""
}

// decodeConfig reads an image's pixel size without decoding it.
func decodeConfig(data []byte, contentType string) (image.Config, error) {
	r := bytes.NewReader(data)
	switch contentType {
	case TypeJPEG:
		return jpeg.DecodeConfig(r)
	case TypePNG:
		return png.DecodeConfig(r)
	default:
		return webp.DecodeConfig(r)
	}
}

// process decodes an image completely (so a damaged one is refused) and
// returns the bytes to store with their pixel size.
//
// JPEG and PNG are always re-encoded in their own format with 8 bits per
// channel, so nothing but pixels is stored: no EXIF (GPS position, camera,
// thumbnail), no PNG text or eXIf chunks, no 16-bit samples. Images wider
// than maxWidth (once upright) are scaled to maxWidth pixels wide, aspect
// ratio kept. The scaled copy is made straight from the decoded image into
// an 8-bit buffer of the target size, and only that small copy is turned
// upright by the EXIF orientation of a JPEG; the full-size image is never
// copied.
//
// WebP is decoded only to validate it and stored as uploaded: Go has no
// WebP encoder, so its metadata chunks (EXIF, XMP) are kept.
func process(data []byte, contentType string, orientation, maxWidth int) ([]byte, int, int, error) {
	if contentType == TypeWebP {
		img, err := webp.Decode(bytes.NewReader(data))
		if err != nil {
			return nil, 0, 0, err
		}
		b := img.Bounds()
		return data, b.Dx(), b.Dy(), nil
	}
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, 0, 0, err
	}
	sb := src.Bounds()
	// Scaled size before orientation (sw × sh) such that the upright image
	// is at most maxWidth wide.
	sw, sh := scaledSize(sb.Dx(), sb.Dy(), maxWidth, orientation >= 5)
	rect := image.Rect(0, 0, sw, sh)

	var buf bytes.Buffer
	if contentType == TypePNG {
		dst := image.NewNRGBA(rect) // 8 bits per channel, transparency kept
		resample(dst, src)
		err = (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(&buf, dst)
		sw, sh = dst.Rect.Dx(), dst.Rect.Dy()
	} else {
		dst := image.NewRGBA(rect)
		resample(dst, src)
		dst = orientRGBA(dst, orientation)
		err = jpeg.Encode(&buf, dst, &jpeg.Options{Quality: jpegQuality})
		sw, sh = dst.Rect.Dx(), dst.Rect.Dy()
	}
	if err != nil {
		return nil, 0, 0, err
	}
	return buf.Bytes(), sw, sh, nil
}

// scaledSize returns the size (w × h) to scale a w × h image to so that,
// turned upright (axes swapped when swap), it is at most maxWidth wide.
func scaledSize(w, h, maxWidth int, swap bool) (int, int) {
	uw, uh := w, h
	if swap {
		uw, uh = h, w
	}
	if uw <= maxWidth {
		return w, h
	}
	nw := maxWidth
	nh := max(1, int(math.Round(float64(uh)*float64(nw)/float64(uw))))
	if swap {
		return nh, nw
	}
	return nw, nh
}

// resample draws src into dst: a plain copy at the same size, else a
// Catmull-Rom scale. Either way the pixels are converted to dst's 8-bit
// format.
func resample(dst draw.Image, src image.Image) {
	sb, db := src.Bounds(), dst.Bounds()
	if sb.Dx() == db.Dx() && sb.Dy() == db.Dy() {
		xdraw.Draw(dst, db, src, sb.Min, xdraw.Src)
		return
	}
	xdraw.CatmullRom.Scale(dst, db, src, sb, xdraw.Src, nil)
}

const jpegQuality = 85

// bytesPerPixel estimates the memory a decoded image of this colour model
// takes per pixel (worst case: YCbCr as 4:4:4).
func bytesPerPixel(m color.Model) int64 {
	switch m {
	case color.GrayModel, color.AlphaModel:
		return 1
	case color.Gray16Model, color.Alpha16Model:
		return 2
	case color.YCbCrModel:
		return 3
	case color.NYCbCrAModel:
		return 4
	case color.RGBA64Model, color.NRGBA64Model:
		return 8
	}
	if _, ok := m.(color.Palette); ok {
		return 1
	}
	return 4 // RGBA, NRGBA, CMYK
}

// decodeCost estimates the bytes processing an image needs at its peak: the
// decoded source plus the 8-bit target, twice for a JPEG that is turned
// upright (process).
func decodeCost(cfg image.Config, contentType string, orientation, maxWidth int) int64 {
	src := int64(cfg.Width) * int64(cfg.Height) * bytesPerPixel(cfg.ColorModel)
	if contentType == TypeWebP {
		return src
	}
	w, h := scaledSize(cfg.Width, cfg.Height, maxWidth, orientation >= 5)
	dst := int64(w) * int64(h) * 4
	if orientation > 1 {
		dst *= 2
	}
	return src + dst
}

// orientationOf returns the EXIF orientation (1-8) of an image: that of a
// JPEG, 1 for other types (PNG and WebP are shown as stored).
func orientationOf(data []byte, contentType string) int {
	if contentType != TypeJPEG {
		return 1
	}
	return jpegOrientation(data)
}

// jpegOrientation returns the EXIF orientation (1-8) of a JPEG, 1 if it has
// none or it cannot be read.
func jpegOrientation(data []byte) int {
	// Walk the segments up to the image data (SOS) looking for APP1 "Exif".
	for i := 2; i+4 <= len(data) && data[i] == 0xff; {
		marker := data[i+1]
		if marker == 0xda || marker == 0xd9 { // start of scan, end of image
			break
		}
		n := int(binary.BigEndian.Uint16(data[i+2 : i+4]))
		if n < 2 || i+2+n > len(data) {
			break
		}
		seg := data[i+4 : i+2+n]
		if marker == 0xe1 && bytes.HasPrefix(seg, []byte("Exif\x00\x00")) {
			return exifOrientation(seg[6:])
		}
		i += 2 + n
	}
	return 1
}

// exifOrientation reads tag 0x0112 of IFD0 of a TIFF header.
func exifOrientation(tiff []byte) int {
	if len(tiff) < 8 {
		return 1
	}
	var order binary.ByteOrder
	switch string(tiff[0:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 1
	}
	ifd := int(order.Uint32(tiff[4:8]))
	if ifd < 8 || ifd+2 > len(tiff) {
		return 1
	}
	count := int(order.Uint16(tiff[ifd : ifd+2]))
	for e := range count {
		off := ifd + 2 + 12*e
		if off+12 > len(tiff) {
			break
		}
		if order.Uint16(tiff[off:off+2]) == 0x0112 {
			if v := int(order.Uint16(tiff[off+8 : off+10])); v >= 1 && v <= 8 {
				return v
			}
			return 1
		}
	}
	return 1
}

// orientRGBA returns img turned upright for an EXIF orientation (1 = as
// is, the same image).
func orientRGBA(img *image.RGBA, orientation int) *image.RGBA {
	if orientation <= 1 || orientation > 8 {
		return img
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	dw, dh := w, h
	if orientation >= 5 { // 5-8 swap the axes
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := range dh {
		for x := range dw {
			var sx, sy int
			switch orientation {
			case 2: // mirrored
				sx, sy = w-1-x, y
			case 3: // upside down
				sx, sy = w-1-x, h-1-y
			case 4: // mirrored upside down
				sx, sy = x, h-1-y
			case 5: // transposed
				sx, sy = y, x
			case 6: // needs 90° clockwise
				sx, sy = y, h-1-x
			case 7: // transversed
				sx, sy = w-1-y, h-1-x
			case 8: // needs 90° counter-clockwise
				sx, sy = w-1-y, x
			}
			si := img.PixOffset(b.Min.X+sx, b.Min.Y+sy)
			copy(dst.Pix[dst.PixOffset(x, y):dst.PixOffset(x, y)+4], img.Pix[si:si+4])
		}
	}
	return dst
}
