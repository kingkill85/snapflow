package proposals

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

const tag = "proposals"

type versionParam struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
}

type idParam struct {
	ID uuid.UUID `path:"id" format:"uuid"`
}

type generateInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      GenerateInput
}

type previewInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      PreviewInput
}

type proposalsOutput struct {
	Body []Proposal
}

type previewOutput struct {
	Body []PreviewDocument
}

type exportersOutput struct {
	Body []ExporterInfo
}

// Register adds the proposal endpoints. Handlers only translate HTTP to
// service calls; all rules live in Service.
func Register(api huma.API, svc *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "listExporters",
		Method:      http.MethodGet,
		Path:        "/api/exporters",
		Summary:     "List the document formats",
		Tags:        []string{tag},
	}, func(ctx context.Context, _ *struct{}) (*exportersOutput, error) {
		out, err := svc.Exporters(ctx)
		if err != nil {
			return nil, err
		}
		return &exportersOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "listProposals",
		Method:      http.MethodGet,
		Path:        "/api/versions/{versionId}/proposals",
		Summary:     "List the proposals of a version",
		Description: "Newest first.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *versionParam) (*proposalsOutput, error) {
		out, err := svc.List(ctx, in.VersionID)
		if err != nil {
			return nil, err
		}
		return &proposalsOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "generateProposals",
		Method:      http.MethodPost,
		Path:        "/api/versions/{versionId}/proposals",
		Summary:     "Generate proposals of a version",
		Description: "One combined proposal, or with split one per product type in productTypeIds (free-text lines only " +
			"in the combined one). Also on completed or cancelled projects. Needs projects.write. Errors: " +
			"422 proposal.exporter_unknown, proposal.empty, proposal.product_types_required, proposal.product_type_not_in_bom.",
		Tags:          []string{tag},
		DefaultStatus: http.StatusCreated,
	}, func(ctx context.Context, in *generateInput) (*proposalsOutput, error) {
		out, err := svc.Generate(ctx, in.VersionID, in.Body)
		if err != nil {
			return nil, err
		}
		return &proposalsOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "previewProposals",
		Method:      http.MethodPost,
		Path:        "/api/versions/{versionId}/proposals/preview",
		Summary:     "Preview the totals of the documents a generation would write",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *previewInput) (*previewOutput, error) {
		out, err := svc.Preview(ctx, in.VersionID, in.Body)
		if err != nil {
			return nil, err
		}
		return &previewOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "downloadProposal",
		Method:      http.MethodGet,
		Path:        "/api/proposals/{id}/file",
		Summary:     "Download a proposal's file",
		Description: "As an attachment named `<number> <project name>.<extension>`.",
		Tags:        []string{tag},
		Responses: map[string]*huma.Response{"200": {Description: "The file", Content: map[string]*huma.MediaType{
			"application/octet-stream": {Schema: &huma.Schema{Type: "string", Format: "binary"}},
		}}},
	}, func(ctx context.Context, in *idParam) (*huma.StreamResponse, error) {
		p, contentType, size, contents, err := svc.File(ctx, in.ID)
		if err != nil {
			return nil, err
		}
		return &huma.StreamResponse{Body: func(hctx huma.Context) {
			defer func() { _ = contents.Close() }()
			hctx.SetHeader("Content-Type", contentType)
			hctx.SetHeader("Content-Length", strconv.FormatInt(size, 10))
			hctx.SetHeader("Content-Disposition", Disposition(p.FileName))
			hctx.SetHeader("Cache-Control", "private, no-cache")
			hctx.SetHeader("X-Content-Type-Options", "nosniff")
			hctx.SetStatus(http.StatusOK)
			if _, err := io.Copy(hctx.BodyWriter(), contents); err != nil {
				slog.WarnContext(ctx, "proposals: send", "id", p.ID, "error", err)
			}
		}}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "deleteProposal",
		Method:        http.MethodDelete,
		Path:          "/api/proposals/{id}",
		Summary:       "Delete a proposal",
		Description:   "Needs projects.delete; also on completed or cancelled projects.",
		Tags:          []string{tag},
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *idParam) (*struct{}, error) {
		return nil, svc.Delete(ctx, in.ID)
	})
}

// Disposition is an attachment header for name: an ASCII fallback (non-ASCII
// replaced by "_") and the exact name RFC 5987-encoded.
func Disposition(name string) string {
	var ascii strings.Builder
	for _, r := range name {
		switch {
		case r == '"' || r == '\\':
			ascii.WriteRune('_')
		case r < 0x20 || r > 0x7e:
			ascii.WriteRune('_')
		default:
			ascii.WriteRune(r)
		}
	}
	var enc strings.Builder
	for _, b := range []byte(name) {
		if b < 0x80 && (b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || strings.IndexByte("!#$&+-.^_`|~", b) >= 0) {
			enc.WriteByte(b)
		} else {
			fmt.Fprintf(&enc, "%%%02X", b)
		}
	}
	return `attachment; filename="` + ascii.String() + `"; filename*=UTF-8''` + enc.String()
}
