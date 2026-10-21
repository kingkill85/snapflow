package plans

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/files"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

const tag = "plans"

// maxContentBytes bounds a content save (2000 placements with instance
// values, 2000 needs with notes).
const maxContentBytes = 12 << 20

type idParam struct {
	ID uuid.UUID `path:"id" format:"uuid"`
}

type imageParam struct {
	ID     uuid.UUID `path:"id" format:"uuid"`
	FileID uuid.UUID `path:"fileId" format:"uuid"`
}

type versionParam struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
}

type planOutput struct {
	Body Plan
}

type plansOutput struct {
	Body []Plan
}

type contentOutput struct {
	Body PlanContent
}

type lockOutput struct {
	Body PlanLock
}

type createForm struct {
	Name  string        `form:"name" required:"true" doc:"1-100 characters, unique in the version ignoring case"`
	Image huma.FormFile `form:"image" required:"true" doc:"JPEG, PNG or WebP image, at most 20 MB and 40 megapixels"`
}

type createInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	RawBody   huma.MultipartFormFiles[createForm]
}

type updateForm struct {
	Name              string        `form:"name" required:"true" doc:"1-100 characters, unique in the version ignoring case"`
	ExpectedUpdatedAt string        `form:"expectedUpdatedAt" required:"true" doc:"updatedAt as last read (RFC 3339); plan.stale otherwise"`
	Image             huma.FormFile `form:"image" required:"false" doc:"A new image (JPEG, PNG or WebP, at most 20 MB and 40 megapixels); left out keeps the current one"`
}

type updateInput struct {
	ID      uuid.UUID `path:"id" format:"uuid"`
	RawBody huma.MultipartFormFiles[updateForm]
}

// PlanOrder is the new order of a version's plans.
type PlanOrder struct {
	IDs []uuid.UUID `json:"ids" maxItems:"1000" doc:"Every plan of the version exactly once, in the new order"`
}

type orderInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      PlanOrder
}

type contentInput struct {
	ID   uuid.UUID `path:"id" format:"uuid"`
	Body PlanContentInput
}

type boardOutput struct {
	Body BoardContent
}

type boardInput struct {
	ID   uuid.UUID `path:"id" format:"uuid"`
	Body BoardContentInput
}

type createBoardInput struct {
	VersionID uuid.UUID `path:"versionId" format:"uuid"`
	Body      BoardCreate
}

type lockInput struct {
	ID    uuid.UUID `path:"id" format:"uuid"`
	Force bool      `query:"force" doc:"Take the lock from another user (needs projects.delete)"`
}

// Register adds the plan endpoints. Handlers only translate HTTP to service
// calls; all rules live in Service.
func Register(api huma.API, svc *Service) {
	upload := huma.Middlewares{files.LimitUpload(auth.PermProjectsWrite, files.FloorplanImage.MaxSize)}

	huma.Register(api, huma.Operation{
		OperationID: "listPlans",
		Method:      http.MethodGet,
		Path:        "/api/versions/{versionId}/plans",
		Summary:     "List the plans of a version",
		Description: "In their order, without content.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *versionParam) (*plansOutput, error) {
		p, err := svc.List(ctx, in.VersionID)
		if err != nil {
			return nil, err
		}
		return &plansOutput{Body: p}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "createPlan",
		Method:      http.MethodPost,
		Path:        "/api/versions/{versionId}/plans",
		Summary:     "Add a plan",
		Description: "Multipart fields `name` and `image`: a JPEG, PNG or WebP image (recognised by its content), at most " +
			"20 MB (413 file.too_large) and 40 megapixels (422 file.too_many_pixels), stored re-encoded without metadata " +
			"at most 4096 px on the long side (WebP as PNG). The plan goes after the version's last plan.",
		Tags:          []string{tag},
		DefaultStatus: http.StatusCreated,
		Middlewares:   upload,
	}, func(ctx context.Context, in *createInput) (*planOutput, error) {
		form := in.RawBody.Data()
		defer func() { _ = form.Image.Close() }()
		p, err := svc.Create(ctx, in.VersionID, form.Name, form.Image)
		if err != nil {
			return nil, err
		}
		return &planOutput{Body: p}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getPlan",
		Method:      http.MethodGet,
		Path:        "/api/plans/{id}",
		Summary:     "Get a plan with its edit lock",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *idParam) (*planOutput, error) {
		p, err := svc.Get(ctx, in.ID)
		if err != nil {
			return nil, err
		}
		return &planOutput{Body: p}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "updatePlan",
		Method:      http.MethodPut,
		Path:        "/api/plans/{id}",
		Summary:     "Rename a plan or replace its image",
		Description: "Multipart fields `name`, `expectedUpdatedAt` and optionally `image` (limits as for create). A new " +
			"image of another size scales zones and placements to it and moves contentUpdatedAt on; it is refused " +
			"while another user holds the edit lock (409 plan.locked).",
		Tags:        []string{tag},
		Middlewares: upload,
	}, func(ctx context.Context, in *updateInput) (*planOutput, error) {
		form := in.RawBody.Data()
		expected, err := time.Parse(time.RFC3339Nano, form.ExpectedUpdatedAt)
		if err != nil {
			return nil, apperr.Invalid("body.expectedUpdatedAt", "validation.invalid", "not an RFC 3339 time")
		}
		upd := PlanUpdate{Name: form.Name, ExpectedUpdatedAt: expected}
		if form.Image.IsSet {
			defer func() { _ = form.Image.Close() }()
			upd.Image = form.Image
		}
		p, err := svc.Update(ctx, in.ID, upd)
		if err != nil {
			return nil, err
		}
		return &planOutput{Body: p}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "deletePlan",
		Method:        http.MethodDelete,
		Path:          "/api/plans/{id}",
		Summary:       "Delete a plan with its content",
		Description:   "Refused while another user holds the edit lock (409 plan.locked).",
		Tags:          []string{tag},
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *idParam) (*struct{}, error) {
		return nil, svc.Delete(ctx, in.ID)
	})

	huma.Register(api, huma.Operation{
		OperationID: "reorderPlans",
		Method:      http.MethodPut,
		Path:        "/api/versions/{versionId}/plans/order",
		Summary:     "Reorder the plans of a version",
		Description: "ids must list every plan of the version exactly once (422 plan.order_mismatch).",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *orderInput) (*plansOutput, error) {
		p, err := svc.Reorder(ctx, in.VersionID, in.Body.IDs)
		if err != nil {
			return nil, err
		}
		return &plansOutput{Body: p}, nil
	})

	binary := &huma.Schema{Type: "string", Format: "binary"}
	huma.Register(api, huma.Operation{
		OperationID: "getPlanImage",
		Method:      http.MethodGet,
		Path:        "/api/plans/{id}/images/{fileId}",
		Summary:     "Download a plan's image",
		Description: "As GET /api/files/{id}, for whoever may read the plan. Use the plan's image.url: only the current " +
			"image is served (plan.image_not_found otherwise), so the URL changes when the image is replaced.",
		Tags: []string{tag},
		Responses: map[string]*huma.Response{
			"200": {Description: "The image", Content: map[string]*huma.MediaType{
				files.TypeJPEG: {Schema: binary}, files.TypePNG: {Schema: binary}, files.TypeWebP: {Schema: binary},
			}},
			"304": {Description: "Not modified"},
		},
	}, func(ctx context.Context, in *imageParam) (*huma.StreamResponse, error) {
		file, contents, err := svc.Image(ctx, in.ID, in.FileID)
		if err != nil {
			return nil, err
		}
		return files.Stream(ctx, file, contents), nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getPlanContent",
		Method:      http.MethodGet,
		Path:        "/api/plans/{id}/content",
		Summary:     "Get a plan's zones, placements and needs",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *idParam) (*contentOutput, error) {
		c, err := svc.Content(ctx, in.ID)
		if err != nil {
			return nil, err
		}
		return &contentOutput{Body: c}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "savePlanContent",
		Method:      http.MethodPut,
		Path:        "/api/plans/{id}/content",
		Summary:     "Replace a plan's zones, placements and needs",
		Description: "Saves the whole content in one transaction and returns it with the computed zone of every " +
			"placement and load symbol (warnings: GET /api/versions/{versionId}/checks, D453). Needs the caller's live edit lock (409 plan.lock_required) and the content " +
			"as last read (409 plan.stale).",
		Tags:         []string{tag},
		MaxBodyBytes: maxContentBytes,
	}, func(ctx context.Context, in *contentInput) (*contentOutput, error) {
		c, err := svc.SaveContent(ctx, in.ID, in.Body)
		if err != nil {
			return nil, err
		}
		return &contentOutput{Body: c}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "createBoard",
		Method:      http.MethodPost,
		Path:        "/api/versions/{versionId}/boards",
		Summary:     "Add a distribution board",
		Description: "A plan of kind board after the version's last plan: with an enclosure of known size its rows " +
			"(enclosureRows x enclosureTePerRow), else the rows given.",
		Tags:          []string{tag},
		DefaultStatus: http.StatusCreated,
	}, func(ctx context.Context, in *createBoardInput) (*planOutput, error) {
		p, err := svc.CreateBoard(ctx, in.VersionID, in.Body)
		if err != nil {
			return nil, err
		}
		return &planOutput{Body: p}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getBoardContent",
		Method:      http.MethodGet,
		Path:        "/api/plans/{id}/board",
		Summary:     "Get a board's enclosure, rows and modules",
		Description: "With the capability summary of every variant used (warnings: the checks, D453). A floorplan is 409 plan.wrong_kind.",
		Tags:        []string{tag},
	}, func(ctx context.Context, in *idParam) (*boardOutput, error) {
		c, err := svc.BoardContent(ctx, in.ID)
		if err != nil {
			return nil, err
		}
		return &boardOutput{Body: c}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "saveBoardContent",
		Method:      http.MethodPut,
		Path:        "/api/plans/{id}/board",
		Summary:     "Replace a board's enclosure, rows and modules",
		Description: "Saves the whole board in one transaction (rows fitted to an enclosure of known size) and returns it " +
			"with widths, capabilities (warnings: the checks, D453). Overlapping modules in a row are 422 board.overlap. Needs the " +
			"caller's live edit lock (409 plan.lock_required) and the content as last read (409 plan.stale).",
		Tags:         []string{tag},
		MaxBodyBytes: maxContentBytes,
	}, func(ctx context.Context, in *boardInput) (*boardOutput, error) {
		c, err := svc.SaveBoard(ctx, in.ID, in.Body)
		if err != nil {
			return nil, err
		}
		return &boardOutput{Body: c}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "lockPlan",
		Method:      http.MethodPost,
		Path:        "/api/plans/{id}/lock",
		Summary:     "Take or renew the edit lock",
		Description: "The editor calls it when it opens and every 30 s; the lock ends 2 minutes after the last call. " +
			"Held by another user: 409 plan.locked (params name, expiresAt), unless force=true by a user with " +
			"projects.delete.",
		Tags: []string{tag},
	}, func(ctx context.Context, in *lockInput) (*lockOutput, error) {
		l, err := svc.Lock(ctx, in.ID, in.Force)
		if err != nil {
			return nil, err
		}
		return &lockOutput{Body: l}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "unlockPlan",
		Method:        http.MethodDelete,
		Path:          "/api/plans/{id}/lock",
		Summary:       "Release the edit lock",
		Description:   "Releases the caller's lock; another user's lock stays.",
		Tags:          []string{tag},
		DefaultStatus: http.StatusNoContent,
	}, func(ctx context.Context, in *idParam) (*struct{}, error) {
		return nil, svc.Unlock(ctx, in.ID)
	})
}
