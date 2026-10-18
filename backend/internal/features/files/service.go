// Package files stores uploaded files (variant images first). Contents live
// on disk under STORAGE_DIR, addressed by their SHA-256, so the same bytes
// are stored once; the files table holds their metadata. Every download
// needs a login. Other features reference files by id and check them with
// Exists; unreferenced files are kept (a cleanup job comes later).
package files

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/files/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

// Limits of an upload.
const (
	// MaxSize is the largest accepted upload, in bytes (10 MB).
	MaxSize = 10 << 20
	// MaxWidth is the widest stored JPEG or PNG; wider ones are scaled down
	// to it. WebP is stored as uploaded.
	MaxWidth = 1600
	// MaxMegapixels bounds the pixel count of an image, so decoding one
	// cannot exhaust memory.
	MaxMegapixels = 40
)

type File struct {
	ID          uuid.UUID `json:"id"`
	ContentType string    `json:"contentType" example:"image/jpeg"`
	Size        int64     `json:"size" doc:"Bytes as stored (after downscaling)"`
	Width       int       `json:"width,omitempty" doc:"Pixels, for images"`
	Height      int       `json:"height,omitempty" doc:"Pixels, for images"`
	SHA256      string    `json:"sha256" doc:"Hex SHA-256 of the stored bytes; also the download's ETag"`
	URL         string    `json:"url" doc:"Download path (needs a login)" example:"/api/files/3f2c…"`
	CreatedAt   time.Time `json:"createdAt"`
}

type Service struct {
	q       store.Querier
	storage *Storage
	// decoding limits concurrent image decodes, which need a lot of memory.
	decoding chan struct{}
}

// NewService returns the service; storage may be nil when the API is only
// built to export the OpenAPI document.
func NewService(q store.Querier, storage *Storage) *Service {
	return &Service{q: q, storage: storage, decoding: make(chan struct{}, 2)}
}

// Upload stores an image (JPEG, PNG or WebP, by magic bytes, at most
// MaxSize). JPEG and PNG must decode completely; those wider than MaxWidth
// are scaled down to it in the same format. Uploading the same stored bytes again returns the existing
// file.
func (s *Service) Upload(ctx context.Context, r io.Reader) (File, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return File{}, err
	}
	data, err := io.ReadAll(io.LimitReader(r, MaxSize+1))
	if err != nil {
		return File{}, err
	}
	if len(data) > MaxSize {
		return File{}, ErrTooLarge()
	}
	contentType := sniff(data)
	if contentType == "" {
		return File{}, errType()
	}
	cfg, err := decodeConfig(data, contentType)
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
		return File{}, errType()
	}
	if int64(cfg.Width)*int64(cfg.Height) > MaxMegapixels*1_000_000 {
		return File{}, apperr.New(http.StatusUnprocessableEntity, "file.too_many_pixels", "the image has too many pixels").
			With("megapixels", MaxMegapixels)
	}
	width, height := cfg.Width, cfg.Height
	if contentType != TypeWebP { // WebP is stored as uploaded
		select {
		case s.decoding <- struct{}{}:
		case <-ctx.Done():
			return File{}, ctx.Err()
		}
		data, width, height, err = process(data, contentType, MaxWidth)
		<-s.decoding
		if err != nil {
			return File{}, errType() // the header was fine, the image data is not
		}
	}

	sum := sha256.Sum256(data)
	hexSum := hex.EncodeToString(sum[:])
	// Contents first: a row never points to missing bytes.
	if err := s.storage.Put(hexSum, data); err != nil {
		return File{}, fmt.Errorf("files: store: %w", err)
	}
	w, h := int32(width), int32(height) //nolint:gosec // bounded by MaxMegapixels
	row, err := s.q.CreateFile(ctx, store.CreateFileParams{
		Sha256: hexSum, ContentType: contentType, Size: int64(len(data)), Width: &w, Height: &h,
	})
	if err != nil {
		return File{}, err
	}
	return fromRow(row), nil
}

// Open returns a file and its contents; any logged-in user may read files.
// The caller closes the reader.
func (s *Service) Open(ctx context.Context, id uuid.UUID) (File, io.ReadSeekCloser, error) {
	if _, err := auth.Require(ctx); err != nil {
		return File{}, nil, err
	}
	row, err := s.q.GetFile(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return File{}, nil, apperr.NotFound("file.not_found")
	}
	if err != nil {
		return File{}, nil, err
	}
	f, err := s.storage.Open(row.Sha256)
	if err != nil {
		return File{}, nil, err
	}
	return fromRow(row), f, nil
}

// Exists reports whether a file exists, for features that reference files.
func (s *Service) Exists(ctx context.Context, id uuid.UUID) (bool, error) {
	if _, err := auth.Require(ctx); err != nil {
		return false, err
	}
	return s.q.FileExists(ctx, id)
}

// ErrTooLarge reports an upload above MaxSize.
func ErrTooLarge() *apperr.Error {
	return apperr.New(http.StatusRequestEntityTooLarge, "file.too_large", "the file is too large").
		With("maxMb", MaxSize>>20)
}

func errType() *apperr.Error {
	return apperr.New(http.StatusUnsupportedMediaType, "file.type", "only JPEG, PNG and WebP images are accepted")
}

func fromRow(r store.File) File {
	f := File{
		ID: r.ID, ContentType: r.ContentType, Size: r.Size, SHA256: r.Sha256,
		URL: "/api/files/" + r.ID.String(), CreatedAt: r.CreatedAt,
	}
	if r.Width != nil {
		f.Width = int(*r.Width)
	}
	if r.Height != nil {
		f.Height = int(*r.Height)
	}
	return f
}
