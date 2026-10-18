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
	"io/fs"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/sync/semaphore"

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
	MaxMegapixels = 25
	// DecodeBudget bounds the memory of all image decodes running at once,
	// in bytes (decodeCost: decoded source plus 8-bit target). The largest
	// single image needs at most 300 MB: a 25 MP 16-bit PNG decodes to
	// 8 bytes per pixel (200 MB) plus a 4-byte target of up to 25 MP (100 MB,
	// a tall image is not scaled); a 25 MP CMYK JPEG 100 MB plus twice its
	// target when it is turned upright (200 MB). Typical photos (8-bit YCbCr,
	// scaled to 1600 px) need well under 100 MB, so several run in parallel;
	// a large one waits until the budget is free. Encoded output and request
	// buffers (each upload at most MaxSize) come on top.
	DecodeBudget = 300 << 20
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
	// decoding holds DecodeBudget bytes; every image decode acquires its
	// decodeCost first.
	decoding *semaphore.Weighted
}

// NewService returns the service; storage may be nil when the API is only
// built to export the OpenAPI document.
func NewService(q store.Querier, storage *Storage) *Service {
	return &Service{q: q, storage: storage, decoding: semaphore.NewWeighted(DecodeBudget)}
}

// WithTx returns the service working inside tx, so Exists and foreign keys
// of the same transaction see the files it stores. It shares the storage
// and the decode budget. Contents written before a rollback stay on disk,
// unreferenced, like any unreferenced file.
func (s *Service) WithTx(tx pgx.Tx) *Service {
	return &Service{q: store.New(tx), storage: s.storage, decoding: s.decoding}
}

// Upload stores an image (JPEG, PNG or WebP, by magic bytes, at most
// MaxSize and MaxMegapixels). Every image must decode completely. JPEG and
// PNG are always re-encoded (8 bits per channel, no metadata), turned
// upright and scaled down to MaxWidth (process); WebP is stored as
// uploaded. Uploading the same stored bytes again returns the existing file.
func (s *Service) Upload(ctx context.Context, r io.Reader) (File, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return File{}, err
	}
	data, err := io.ReadAll(io.LimitReader(r, MaxSize+1))
	if err != nil {
		return File{}, err
	}
	return s.UploadBytes(ctx, data)
}

// UploadBytes is Upload for an image already in memory (e.g. one taken from
// an imported workbook).
func (s *Service) UploadBytes(ctx context.Context, data []byte) (File, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
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
	orientation := orientationOf(data, contentType)
	cost := min(decodeCost(cfg, contentType, orientation, MaxWidth), DecodeBudget)
	if err := s.decoding.Acquire(ctx, cost); err != nil {
		return File{}, err
	}
	data, width, height, err := process(data, contentType, orientation, MaxWidth)
	s.decoding.Release(cost)
	if err != nil {
		return File{}, errType() // the header was fine, the image data is not
	}

	w, h := int32(width), int32(height) //nolint:gosec // bounded by MaxMegapixels
	return s.put(ctx, data, contentType, &w, &h)
}

// StoreDocument stores a non-image file as it is (e.g. an import workbook
// kept with its import run). The caller checks its type and size; the same
// bytes give the same file.
func (s *Service) StoreDocument(ctx context.Context, data []byte, contentType string) (File, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return File{}, err
	}
	return s.put(ctx, data, contentType, nil, nil)
}

// put stores contents (first, so a row never points to missing bytes) and
// their metadata.
func (s *Service) put(ctx context.Context, data []byte, contentType string, width, height *int32) (File, error) {
	sum := sha256.Sum256(data)
	hexSum := hex.EncodeToString(sum[:])
	if err := s.storage.Put(hexSum, data); err != nil {
		return File{}, fmt.Errorf("files: store: %w", err)
	}
	row, err := s.q.CreateFile(ctx, store.CreateFileParams{
		Sha256: hexSum, ContentType: contentType, Size: int64(len(data)), Width: width, Height: height,
	})
	if err != nil {
		return File{}, err
	}
	return fromRow(row), nil
}

// ReadAll returns a file's contents (at most max bytes, else
// file.too_large), e.g. an import's workbook.
func (s *Service) ReadAll(ctx context.Context, id uuid.UUID, max int64) (File, []byte, error) {
	f, contents, err := s.Open(ctx, id)
	if err != nil {
		return File{}, nil, err
	}
	defer func() { _ = contents.Close() }()
	data, err := io.ReadAll(io.LimitReader(contents, max+1))
	if err != nil {
		return File{}, nil, err
	}
	if int64(len(data)) > max {
		return File{}, nil, ErrTooLarge()
	}
	return f, data, nil
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
	if errors.Is(err, fs.ErrNotExist) {
		return File{}, nil, apperr.Internal(ctx, "files: integrity error: contents missing on disk",
			fmt.Errorf("file %s (sha256 %s): %w", row.ID, row.Sha256, err))
	}
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
