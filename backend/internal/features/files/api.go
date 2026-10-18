package files

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

const tag = "files"

type uploadForm struct {
	File huma.FormFile `form:"file" required:"true" doc:"JPEG, PNG or WebP image, at most 10 MB"`
}

type uploadInput struct {
	RawBody huma.MultipartFormFiles[uploadForm]
}

type fileOutput struct {
	Body File
}

type getInput struct {
	ID uuid.UUID `path:"id" format:"uuid"`
}

// Register adds the file endpoints. Handlers only translate HTTP to service
// calls; all rules live in Service.
func Register(api huma.API, svc *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "uploadFile",
		Method:      http.MethodPost,
		Path:        "/api/files",
		Summary:     "Upload a catalog image",
		Description: "Multipart field `file`: a JPEG, PNG or WebP image (recognised by its content, not its name), " +
			"at most 10 MB (413 file.too_large, also for a chunked body) and 25 megapixels (422 file.too_many_pixels). " +
			"Other or damaged content is 415 file.type. JPEG and PNG are re-encoded in the same format without metadata, " +
			"turned upright and scaled down to 1600 px wide; WebP is validated and stored as uploaded. " +
			"The same stored bytes always give the same file.",
		Tags:          []string{tag},
		DefaultStatus: http.StatusCreated,
		Middlewares:   huma.Middlewares{LimitUpload(auth.PermCatalogWrite, MaxSize)},
	}, func(ctx context.Context, in *uploadInput) (*fileOutput, error) {
		f := in.RawBody.Data().File
		defer func() { _ = f.Close() }()
		if f.Size > MaxSize {
			return nil, ErrTooLarge()
		}
		file, err := svc.Upload(ctx, Catalog, f)
		if err != nil {
			return nil, err
		}
		return &fileOutput{Body: file}, nil
	})

	binary := &huma.Schema{Type: "string", Format: "binary"}
	huma.Register(api, huma.Operation{
		OperationID: "getFile",
		Method:      http.MethodGet,
		Path:        "/api/files/{id}",
		Summary:     "Download a file",
		Description: "Needs a login (the session cookie works for <img>). Contents never change: the ETag is the " +
			"SHA-256 and responses may be cached privately for a year; If-None-Match gives 304.",
		Tags: []string{tag},
		Responses: map[string]*huma.Response{
			"200": {Description: "The file", Content: map[string]*huma.MediaType{
				TypeJPEG: {Schema: binary}, TypePNG: {Schema: binary}, TypeWebP: {Schema: binary},
			}},
			"304": {Description: "Not modified"},
		},
	}, func(ctx context.Context, in *getInput) (*huma.StreamResponse, error) {
		file, contents, err := svc.Open(ctx, in.ID)
		if err != nil {
			return nil, err
		}
		return Stream(ctx, file, contents), nil
	})
}

// Stream sends a file opened with Open or OpenReferenced (and closes it).
// Contents never change: the ETag is the SHA-256, responses may be cached
// privately for a year, If-None-Match gives 304.
func Stream(ctx context.Context, file File, contents io.ReadSeekCloser) *huma.StreamResponse {
	return &huma.StreamResponse{Body: func(hctx huma.Context) {
		defer func() { _ = contents.Close() }()
		etag := `"` + file.SHA256 + `"`
		hctx.SetHeader("ETag", etag)
		hctx.SetHeader("Cache-Control", "private, max-age=31536000, immutable")
		hctx.SetHeader("X-Content-Type-Options", "nosniff")
		if matches(hctx.Header("If-None-Match"), etag) {
			hctx.SetStatus(http.StatusNotModified)
			return
		}
		hctx.SetHeader("Content-Type", file.ContentType)
		hctx.SetHeader("Content-Length", strconv.FormatInt(file.Size, 10))
		disposition := "inline"
		if !strings.HasPrefix(file.ContentType, "image/") {
			disposition = "attachment" // e.g. an import workbook: never rendered
		}
		hctx.SetHeader("Content-Disposition", disposition)
		hctx.SetStatus(http.StatusOK)
		if _, err := io.Copy(hctx.BodyWriter(), contents); err != nil {
			slog.WarnContext(ctx, "files: send", "id", file.ID, "error", err)
		}
	}}
}

// matches reports whether an If-None-Match header lists etag (or is "*").
func matches(header, etag string) bool {
	for _, t := range strings.Split(header, ",") {
		t = strings.TrimPrefix(strings.TrimSpace(t), "W/")
		if t == etag || t == "*" {
			return true
		}
	}
	return false
}

// LimitUpload returns a middleware for an upload of at most maxBytes that
// needs perm: it refuses uploads that announce more than maxBytes plus
// multipart overhead before anything is read, and caps the body for those
// that do not announce their size (chunked; multipart parts are buffered to
// disk, so an unbounded body would fill it). It parses the multipart form
// itself so that a body cut off by the cap is 413 file.too_large, not a
// generic form error; huma then uses the parsed form.
func LimitUpload(perm auth.Permission, maxBytes int) func(huma.Context, func(huma.Context)) {
	maxRequest := int64(maxBytes) + 64<<10
	return func(ctx huma.Context, next func(huma.Context)) {
		// The permission first: nobody without it gets a body parsed (and
		// multipart parts spilled to disk).
		if _, err := auth.Require(ctx.Context(), perm); err != nil {
			var ae *apperr.Error
			if errors.As(err, &ae) {
				writeProblem(ctx, ae)
				return
			}
		}
		r, w := humachi.Unwrap(ctx)
		if r.ContentLength > maxRequest {
			writeProblem(ctx, ErrTooLargeMax(maxBytes))
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxRequest)
		if err := r.ParseMultipartForm(humachi.MultipartMaxMemory); err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				writeProblem(ctx, ErrTooLargeMax(maxBytes))
				return
			}
			// Anything else (not multipart, malformed) is reported by huma.
		}
		next(ctx)
	}
}

// writeProblem writes an error before the operation runs (huma.WriteErr would
// derive a generic code from the status).
func writeProblem(ctx huma.Context, err interface {
	GetStatus() int
	Error() string
},
) {
	ctx.SetHeader("Content-Type", "application/problem+json")
	ctx.SetStatus(err.GetStatus())
	_ = json.NewEncoder(ctx.BodyWriter()).Encode(err)
}
