package installation

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/proposals"
)

const tag = "installation"

type versionParam struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
}

type idParam struct {
	ID uuid.UUID `path:"id" format:"uuid"`
}

type documentsOutput struct{ Body []GeneratedDocument }

type documentOutput struct{ Body GeneratedDocument }

type generateInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      DocumentInput
}

func fileResponse(description string) map[string]*huma.Response {
	return map[string]*huma.Response{"200": {Description: description, Content: map[string]*huma.MediaType{
		"application/octet-stream": {Schema: &huma.Schema{Type: "string", Format: "binary"}},
	}}}
}

func send(ctx context.Context, name, contentType string, size int64, body io.Reader) *huma.StreamResponse {
	return &huma.StreamResponse{Body: func(hctx huma.Context) {
		hctx.SetHeader("Content-Type", contentType)
		hctx.SetHeader("Content-Length", strconv.FormatInt(size, 10))
		hctx.SetHeader("Content-Disposition", proposals.Disposition(name))
		hctx.SetHeader("Cache-Control", "private, no-cache")
		hctx.SetHeader("X-Content-Type-Options", "nosniff")
		hctx.SetStatus(http.StatusOK)
		if _, err := io.Copy(hctx.BodyWriter(), body); err != nil {
			slog.WarnContext(ctx, "installation: send", "name", name, "error", err)
		}
	}}
}

// Register adds the installation endpoints. Handlers only translate HTTP to
// service calls; all rules live in Service.
func Register(api huma.API, svc *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "listDocuments",
		Method:      http.MethodGet,
		Path:        "/api/versions/{versionId}/documents",
		Summary:     "List the generated installation documents of a version",
		Description: "Installation manuals and channel labels, newest first (proposals have their own list).",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *versionParam) (*documentsOutput, error) {
		out, err := svc.List(ctx, in.VersionID)
		if err != nil {
			return nil, err
		}
		return &documentsOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "generateDocument",
		Method:        http.MethodPost,
		Path:          "/api/versions/{versionId}/documents",
		Summary:       "Generate an installation manual or the channel labels",
		Description:   "DOCX in the project's language; needs projects.write, also on completed projects (like proposals).",
		Tags:          []string{tag},
		DefaultStatus: http.StatusCreated,
	}, func(ctx context.Context, in *generateInput) (*documentOutput, error) {
		out, err := svc.Generate(ctx, in.VersionID, in.Body)
		if err != nil {
			return nil, err
		}
		return &documentOutput{Body: out}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "downloadDocument",
		Method:      http.MethodGet,
		Path:        "/api/documents/{id}/file",
		Summary:     "Download a generated document's file",
		Tags:        []string{tag},
		Responses:   fileResponse("The file"),
	}, func(ctx context.Context, in *idParam) (*huma.StreamResponse, error) {
		name, contentType, size, contents, err := svc.File(ctx, in.ID)
		if err != nil {
			return nil, err
		}
		return &huma.StreamResponse{Body: func(hctx huma.Context) {
			defer func() { _ = contents.Close() }()
			send(ctx, name, contentType, size, contents).Body(hctx)
		}}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "deleteDocument",
		Method:        http.MethodDelete,
		Path:          "/api/documents/{id}",
		Summary:       "Delete a generated document",
		Description:   "Needs projects.delete; also on completed or cancelled projects.",
		Tags:          []string{tag},
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *idParam) (*struct{}, error) {
		return nil, svc.Delete(ctx, in.ID)
	})

	huma.Register(api, huma.Operation{
		OperationID: "exportKnxGroupAddresses",
		Method:      http.MethodGet,
		Path:        "/api/versions/{versionId}/exports/knx-group-addresses.csv",
		Summary:     "Export the KNX group addresses (ETS CSV import)",
		Description: "ETS 3-level group address CSV (D422): UTF-8 with BOM, comma separated, every field quoted.",
		Tags:        []string{tag},
		Responses:   fileResponse("The CSV file"),
	}, func(ctx context.Context, in *versionParam) (*huma.StreamResponse, error) {
		e, err := svc.GroupAddressesCSV(ctx, in.VersionID)
		if err != nil {
			return nil, err
		}
		return exportResponse(ctx, e), nil
	})

	for _, kind := range []struct{ key, id, summary string }{
		{ListHDL, "exportHdlCommissioning", "Export the HDL commissioning list (XLSX)"},
		{ListZigbee, "exportZigbeeDevices", "Export the Zigbee device list (XLSX)"},
		{ListKNX, "exportKnxDevices", "Export the KNX device list (XLSX)"},
	} {
		huma.Register(api, huma.Operation{
			OperationID: kind.id,
			Method:      http.MethodGet,
			Path:        "/api/versions/{versionId}/exports/" + kind.key + ".xlsx",
			Summary:     kind.summary,
			Description: "One sheet per bus line or gateway (D423).",
			Tags:        []string{tag},
			Responses:   fileResponse("The XLSX file"),
		}, func(ctx context.Context, in *versionParam) (*huma.StreamResponse, error) {
			e, err := svc.CommissioningList(ctx, in.VersionID, kind.key)
			if err != nil {
				return nil, err
			}
			return exportResponse(ctx, e), nil
		})
	}
}

func exportResponse(ctx context.Context, e Export) *huma.StreamResponse {
	return send(ctx, e.FileName, e.ContentType, int64(len(e.Data)), bytesReader(e.Data))
}

func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }
