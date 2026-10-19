package files

import (
	"bytes"
	"context"
	"errors"
	"image"
	"io"
	"math"
	"net/http"

	"github.com/google/uuid"
	xdraw "golang.org/x/image/draw"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
)

// maxDecodeMegapixels bounds an image decoded for a document: the largest
// stored image (a floorplan, FloorplanImage).
const maxDecodeMegapixels = 40

// DecodeImage decodes a stored image for drawing (e.g. into a proposal)
// within the decode budget (DecodeBudget) and scales it down at once to at
// most maxSide pixels on the long side (0: as it is), so only the small
// copy stays in memory. It returns nil without an error when data is not
// a decodable image or has too many pixels.
func (s *Service) DecodeImage(ctx context.Context, data []byte, maxSide int) (image.Image, error) {
	contentType := sniff(data)
	if contentType == "" {
		return nil, nil
	}
	cfg, err := decodeConfig(data, contentType)
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > maxDecodeMegapixels*1_000_000 {
		return nil, nil //nolint:nilerr // not an image to draw
	}
	w, h := scaleTo(cfg.Width, cfg.Height, maxSide)
	cost := min(int64(cfg.Width)*int64(cfg.Height)*bytesPerPixel(cfg.ColorModel)+int64(w)*int64(h)*4, DecodeBudget)
	if err := s.decoding.Acquire(ctx, cost); err != nil {
		return nil, err
	}
	defer s.decoding.Release(cost)
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, nil //nolint:nilerr // an undecodable image is drawn as a box
	}
	if w == cfg.Width && h == cfg.Height {
		return src, nil
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Src, nil)
	return dst, nil
}

// DecodeReferenced reads a file (OpenReferenced: the caller checked the
// row that references it) of at most maxBytes and decodes it (DecodeImage);
// nil when it is gone, too large or not an image.
func (s *Service) DecodeReferenced(ctx context.Context, id uuid.UUID, maxSide int, maxBytes int64) (image.Image, error) {
	_, contents, err := s.OpenReferenced(ctx, id)
	var ae *apperr.Error
	if errors.As(err, &ae) && ae.Status == http.StatusNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(contents, maxBytes+1))
	_ = contents.Close()
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, nil
	}
	return s.DecodeImage(ctx, data, maxSide)
}

// scaleTo is w × h scaled down to at most maxSide on the long side.
func scaleTo(w, h, maxSide int) (int, int) {
	long := max(w, h)
	if maxSide <= 0 || long <= maxSide {
		return w, h
	}
	k := float64(maxSide) / float64(long)
	return max(1, int(math.Round(float64(w)*k))), max(1, int(math.Round(float64(h)*k)))
}
