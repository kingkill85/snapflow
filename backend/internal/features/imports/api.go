package imports

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
)

const tag = "imports"

// maxRequestBytes bounds an upload request: the file plus multipart
// overhead.
const maxRequestBytes = MaxFileSize + 64<<10

type idParam struct {
	ID uuid.UUID `path:"id" format:"uuid"`
}

type profileOutput struct{ Body ImportProfile }

type profilesOutput struct{ Body []ImportProfile }

type updateProfileInput struct {
	ID   uuid.UUID `path:"id" format:"uuid"`
	Body ImportProfileUpdate
}

type targetsInput struct {
	CategoryIDs []string `query:"categoryId" doc:"Only the attributes of these categories (repeat or comma-separate); all categories when empty"`
}

type targetsOutput struct{ Body []ImportTarget }

type uploadForm struct {
	File      huma.FormFile `form:"file" required:"true" doc:".xlsx workbook or UTF-8 .csv (; or , separated), at most 50 MB"`
	ProfileID string        `form:"profileId" required:"false" doc:"Preview at once with this profile"`
}

type uploadInput struct {
	RawBody huma.MultipartFormFiles[uploadForm]
}

type runOutput struct{ Body ImportRun }

type runsInput struct {
	Limit  int `query:"limit" default:"50" minimum:"1" maximum:"500" doc:"Page size, 1-500"`
	Offset int `query:"offset" default:"0" minimum:"0" maximum:"1073741824" doc:"Rows to skip"`
}

type runsOutput struct{ Body ImportRunPage }

type sourceInput struct {
	ID        uuid.UUID `path:"id" format:"uuid"`
	Sheet     string    `query:"sheet" maxLength:"100" doc:"Sheet name; empty for the first"`
	HeaderRow int       `query:"headerRow" default:"1" minimum:"0" maximum:"1000000" doc:"Row number of the column headers (0: none)"`
	Rows      int       `query:"rows" default:"5" minimum:"1" maximum:"50" doc:"How many data rows to show"`
}

type sourceOutput struct{ Body ImportSourcePreview }

type previewInput struct {
	ID   uuid.UUID `path:"id" format:"uuid"`
	Body ImportPreviewInput
}

type itemsInput struct {
	ID          uuid.UUID `path:"id" format:"uuid"`
	Entity      string    `query:"entity" enum:"category,product,variant," doc:"Only items of this entity"`
	Status      string    `query:"status" enum:"new,changed,unchanged,deactivate," doc:"Only items with this status"`
	OnlySkipped bool      `query:"skipped" doc:"Only items of rows with errors"`
	Limit       int       `query:"limit" default:"50" minimum:"1" maximum:"500" doc:"Page size, 1-500"`
	Offset      int       `query:"offset" default:"0" minimum:"0" maximum:"1073741824" doc:"Rows to skip"`
}

type itemsOutput struct{ Body ImportItemPage }

type issuesInput struct {
	ID       uuid.UUID `path:"id" format:"uuid"`
	Severity string    `query:"severity" enum:"error,warning," doc:"Only errors or only warnings"`
	Limit    int       `query:"limit" default:"50" minimum:"1" maximum:"500" doc:"Page size, 1-500"`
	Offset   int       `query:"offset" default:"0" minimum:"0" maximum:"1073741824" doc:"Rows to skip"`
}

type issuesOutput struct{ Body ImportIssuePage }

type applyInput struct {
	ID   uuid.UUID `path:"id" format:"uuid"`
	Body *ImportApplyInput
}

type changesInput struct {
	ID     uuid.UUID `path:"id" format:"uuid"`
	Limit  int       `query:"limit" default:"50" minimum:"1" maximum:"500" doc:"Page size, 1-500"`
	Offset int       `query:"offset" default:"0" minimum:"0" maximum:"1073741824" doc:"Rows to skip"`
}

type changesOutput struct{ Body ImportChangePage }

// Register adds the import endpoints. Handlers only translate HTTP to
// service calls; all rules live in Service.
func Register(api huma.API, svc *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "listImportProfiles", Method: http.MethodGet, Path: "/api/import-profiles",
		Summary: "List import profiles", Description: "By name. With no profile at all, the starter profile \"SnapFlow 1 workbook\" is created first.",
		Tags: []string{tag},
	}, func(ctx context.Context, _ *struct{}) (*profilesOutput, error) {
		list, err := svc.Profiles(ctx)
		if err != nil {
			return nil, err
		}
		return &profilesOutput{Body: list}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getImportProfile", Method: http.MethodGet, Path: "/api/import-profiles/{id}",
		Summary: "Get an import profile", Tags: []string{tag},
	}, func(ctx context.Context, in *idParam) (*profileOutput, error) {
		p, err := svc.Profile(ctx, in.ID)
		if err != nil {
			return nil, err
		}
		return &profileOutput{Body: p}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "createImportProfile", Method: http.MethodPost, Path: "/api/import-profiles",
		Summary: "Create an import profile", Tags: []string{tag}, DefaultStatus: http.StatusCreated,
	}, func(ctx context.Context, in *struct{ Body ImportProfileInput }) (*profileOutput, error) {
		p, err := svc.CreateProfile(ctx, in.Body)
		if err != nil {
			return nil, err
		}
		return &profileOutput{Body: p}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "updateImportProfile", Method: http.MethodPut, Path: "/api/import-profiles/{id}",
		Summary: "Update an import profile", Tags: []string{tag},
	}, func(ctx context.Context, in *updateProfileInput) (*profileOutput, error) {
		p, err := svc.UpdateProfile(ctx, in.ID, in.Body)
		if err != nil {
			return nil, err
		}
		return &profileOutput{Body: p}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "deleteImportProfile", Method: http.MethodDelete, Path: "/api/import-profiles/{id}",
		Summary: "Delete an import profile", Description: "Runs keep their copy of the mapping.",
		Tags: []string{tag}, DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *idParam) (*struct{}, error) {
		return nil, svc.DeleteProfile(ctx, in.ID)
	})

	huma.Register(api, huma.Operation{
		OperationID: "listImportTargets", Method: http.MethodGet, Path: "/api/import-targets",
		Summary: "List mapping targets", Description: "The fixed targets, then the attribute keys of the categories with their definitions per category.",
		Tags: []string{tag},
	}, func(ctx context.Context, in *targetsInput) (*targetsOutput, error) {
		ids := make([]uuid.UUID, 0, len(in.CategoryIDs))
		for _, s := range in.CategoryIDs {
			id, err := uuid.Parse(s)
			if err != nil {
				return nil, apperr.Invalid("query.categoryId", "validation.invalid", "not a uuid")
			}
			ids = append(ids, id)
		}
		list, err := svc.Targets(ctx, ids)
		if err != nil {
			return nil, err
		}
		return &targetsOutput{Body: list}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "listImports", Method: http.MethodGet, Path: "/api/imports",
		Summary: "List import runs", Description: "Newest first.", Tags: []string{tag},
	}, func(ctx context.Context, in *runsInput) (*runsOutput, error) {
		page, err := svc.Runs(ctx, in.Limit, in.Offset)
		if err != nil {
			return nil, err
		}
		return &runsOutput{Body: page}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "createImport", Method: http.MethodPost, Path: "/api/imports",
		Summary: "Upload a file to import",
		Description: "Multipart field `file`: an .xlsx workbook or a UTF-8 .csv, recognised by extension and content " +
			"(415 import.file_type), at most 50 MB (413 import.too_large), 20 000 rows (422 import.too_many_rows) and " +
			"5 000 pictures (422 import.too_many_images). Creates a run in state uploaded; with `profileId` it is previewed at once.",
		Tags: []string{tag}, DefaultStatus: http.StatusCreated, Middlewares: huma.Middlewares{limitBody},
	}, func(ctx context.Context, in *uploadInput) (*runOutput, error) {
		form := in.RawBody.Data()
		f := form.File
		defer func() { _ = f.Close() }()
		if f.Size > MaxFileSize {
			return nil, ErrTooLarge()
		}
		var profileID *uuid.UUID
		if form.ProfileID != "" {
			id, err := uuid.Parse(form.ProfileID)
			if err != nil {
				return nil, apperr.Invalid("body.profileId", "validation.invalid", "not a uuid")
			}
			profileID = &id
		}
		data, err := io.ReadAll(io.LimitReader(f, MaxFileSize+1))
		if err != nil {
			return nil, err
		}
		run, err := svc.Upload(ctx, f.Filename, data, profileID)
		if err != nil {
			return nil, err
		}
		return &runOutput{Body: run}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getImport", Method: http.MethodGet, Path: "/api/imports/{id}",
		Summary: "Get an import run", Tags: []string{tag},
	}, func(ctx context.Context, in *idParam) (*runOutput, error) {
		run, err := svc.Run(ctx, in.ID)
		if err != nil {
			return nil, err
		}
		return &runOutput{Body: run}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getImportSource", Method: http.MethodGet, Path: "/api/imports/{id}/source",
		Summary: "Show the file's columns and first rows", Description: "For mapping: sheets, the columns with their header texts and the first data rows.",
		Tags: []string{tag},
	}, func(ctx context.Context, in *sourceInput) (*sourceOutput, error) {
		src, err := svc.Source(ctx, in.ID, in.Sheet, in.HeaderRow, in.Rows)
		if err != nil {
			return nil, err
		}
		return &sourceOutput{Body: src}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "previewImport", Method: http.MethodPost, Path: "/api/imports/{id}/preview",
		Summary: "Preview an import",
		Description: "Computes the diff against the catalog with a profile (`profileId`) or an unsaved `mapping` and stores it; " +
			"possible until the run is applied. ImportMapping problems are 422 at `mapping.*` (profile) or `body.mapping.*`, " +
			"e.g. import.column_missing; a file without data rows is 422 import.no_rows.",
		Tags: []string{tag},
	}, func(ctx context.Context, in *previewInput) (*runOutput, error) {
		run, err := svc.Preview(ctx, in.ID, in.Body)
		if err != nil {
			return nil, err
		}
		return &runOutput{Body: run}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "listImportItems", Method: http.MethodGet, Path: "/api/imports/{id}/items",
		Summary: "List a preview's changes", Description: "The diff in apply order: categories to create, then each product with its variants, then products to deactivate.",
		Tags: []string{tag},
	}, func(ctx context.Context, in *itemsInput) (*itemsOutput, error) {
		page, err := svc.Items(ctx, in.ID, ImportItemFilter{Entity: in.Entity, Status: in.Status, OnlySkipped: in.OnlySkipped, Limit: in.Limit, Offset: in.Offset})
		if err != nil {
			return nil, err
		}
		return &itemsOutput{Body: page}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "listImportIssues", Method: http.MethodGet, Path: "/api/imports/{id}/issues",
		Summary: "List row errors and warnings", Tags: []string{tag},
	}, func(ctx context.Context, in *issuesInput) (*issuesOutput, error) {
		page, err := svc.Issues(ctx, in.ID, in.Severity, in.Limit, in.Offset)
		if err != nil {
			return nil, err
		}
		return &issuesOutput{Body: page}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "applyImport", Method: http.MethodPost, Path: "/api/imports/{id}/apply",
		Summary: "Apply a previewed import",
		Description: "Writes the previewed diff in one transaction. 409 import.stale if the catalog changed since the preview " +
			"(preview again), 409 import.state unless previewed, 422 import.has_errors with all or nothing while rows have errors. " +
			"A write that fails rolls everything back: the run comes back in state failed with `error`.",
		Tags: []string{tag},
	}, func(ctx context.Context, in *applyInput) (*runOutput, error) {
		body := ImportApplyInput{}
		if in.Body != nil {
			body = *in.Body
		}
		run, err := svc.Apply(ctx, in.ID, body)
		if err != nil {
			return nil, err
		}
		return &runOutput{Body: run}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "undoImport", Method: http.MethodPost, Path: "/api/imports/{id}/undo",
		Summary: "Undo an applied import",
		Description: "Reverts everything the run changed, in one transaction. 409 import.undo_conflict (params.count, " +
			"params.entities: [{entity, id, label, productId}]) if anything it touched changed since.",
		Tags: []string{tag},
	}, func(ctx context.Context, in *idParam) (*runOutput, error) {
		run, err := svc.Undo(ctx, in.ID)
		if err != nil {
			return nil, err
		}
		return &runOutput{Body: run}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "listImportChanges", Method: http.MethodGet, Path: "/api/imports/{id}/changes",
		Summary: "List an applied run's change log", Tags: []string{tag},
	}, func(ctx context.Context, in *changesInput) (*changesOutput, error) {
		page, err := svc.Changes(ctx, in.ID, in.Limit, in.Offset)
		if err != nil {
			return nil, err
		}
		return &changesOutput{Body: page}, nil
	})
}

// limitBody refuses uploads that announce more than maxRequestBytes and
// caps chunked ones (see files.limitBody), answering import.too_large.
func limitBody(ctx huma.Context, next func(huma.Context)) {
	r, w := humachi.Unwrap(ctx)
	if r.ContentLength > maxRequestBytes {
		writeProblem(ctx, ErrTooLarge())
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
	if err := r.ParseMultipartForm(humachi.MultipartMaxMemory); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeProblem(ctx, ErrTooLarge())
			return
		}
	}
	next(ctx)
}

func writeProblem(ctx huma.Context, err *apperr.Error) {
	ctx.SetHeader("Content-Type", "application/problem+json")
	ctx.SetStatus(err.GetStatus())
	_ = json.NewEncoder(ctx.BodyWriter()).Encode(err)
}
