package files

import (
	"bytes"
	"encoding/binary"
	"image"
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

// process decodes a JPEG or PNG completely (so a damaged one is refused).
// A JPEG whose EXIF orientation is not upright is turned upright (re-encoding
// drops EXIF, so browsers could no longer rotate it). If the image is wider
// than maxWidth, it is scaled to maxWidth pixels wide (aspect ratio kept).
// Changed images are encoded in the same format (PNG keeps transparency);
// otherwise data is returned unchanged.
func process(data []byte, contentType string, maxWidth int) ([]byte, int, int, error) {
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, 0, 0, err
	}
	orientation := 1
	if contentType == TypeJPEG {
		orientation = jpegOrientation(data)
		src = orient(src, orientation)
	}
	b := src.Bounds()
	if b.Dx() <= maxWidth && orientation == 1 {
		return data, b.Dx(), b.Dy(), nil
	}
	width := min(b.Dx(), maxWidth)
	height := max(1, int(math.Round(float64(b.Dy())*float64(width)/float64(b.Dx()))))
	rect := image.Rect(0, 0, width, height)

	var buf bytes.Buffer
	if contentType == TypePNG {
		dst := image.NewNRGBA(rect)
		xdraw.CatmullRom.Scale(dst, rect, src, b, xdraw.Src, nil)
		err = (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(&buf, dst)
	} else {
		dst := image.NewRGBA(rect)
		xdraw.CatmullRom.Scale(dst, rect, src, b, xdraw.Src, nil)
		err = jpeg.Encode(&buf, dst, &jpeg.Options{Quality: jpegQuality})
	}
	if err != nil {
		return nil, 0, 0, err
	}
	return buf.Bytes(), width, height, nil
}

const jpegQuality = 85

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

// orient returns img turned upright for an EXIF orientation (1 = as is).
func orient(img image.Image, orientation int) image.Image {
	if orientation <= 1 || orientation > 8 {
		return img
	}
	b := img.Bounds()
	src := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	xdraw.Draw(src, src.Bounds(), img, b.Min, xdraw.Src)
	w, h := b.Dx(), b.Dy()
	dw, dh := w, h
	if orientation >= 5 { // 5-8 swap the axes
		dw, dh = h, w
	}
	dst := image.NewNRGBA(image.Rect(0, 0, dw, dh))
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
			copy(dst.Pix[dst.PixOffset(x, y):dst.PixOffset(x, y)+4], src.Pix[src.PixOffset(sx, sy):src.PixOffset(sx, sy)+4])
		}
	}
	return dst
}
