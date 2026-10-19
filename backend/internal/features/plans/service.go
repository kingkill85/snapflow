// Package plans manages the plans of a project version (step 2b:
// floorplans): a background image with zones (rooms) and placed catalog
// products. A plan's content (zones and placements) is saved as a whole by
// the editor, which holds the plan's edit lock while it is open.
//
// Plans are tenant-owned like projects: every query runs in
// database.InScope (row-level security). Versions and their projects are
// read through projects.Service (ReadVersion, WriteVersion), the catalog
// through products.Service, images through files.Service and lock holders'
// names through users.Service; this feature never reads their tables.
package plans

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/features/files"
	"github.com/kingkill85/snapflow/backend/internal/features/plans/store"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/features/users"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
)

// DB is the database the service runs on; *pgxpool.Pool implements it.
type DB interface {
	store.DBTX
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

type Service struct {
	db       DB
	q        *store.Queries
	projects *projects.Service
	products *products.Service
	files    *files.Service
	users    *users.Service
	// now is the clock of edit locks.
	now func() time.Time
	// contentHooks run when a plan's content is saved (OnContentSave).
	contentHooks []ContentHook
}

func NewService(db DB, projectSvc *projects.Service, productSvc *products.Service, fileSvc *files.Service, userSvc *users.Service) *Service {
	return &Service{db: db, q: store.New(db), projects: projectSvc, products: productSvc, files: fileSvc, users: userSvc, now: time.Now}
}

// inScope runs fn in one transaction scoped to actor (row-level security).
func (s *Service) inScope(ctx context.Context, actor auth.Actor, opts pgx.TxOptions, fn func(tx pgx.Tx, q *store.Queries) error) error {
	return database.InScope(ctx, s.db, actor, opts, func(tx pgx.Tx) error { return fn(tx, s.q.WithTx(tx)) })
}

// ---------------------------------------------------------------- plans

// List returns the plans of a version in their order.
func (s *Service) List(ctx context.Context, versionID uuid.UUID) ([]Plan, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return nil, err
	}
	var (
		ref  projects.VersionRef
		rows []store.ListPlansRow
	)
	err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
		var err error
		if ref, err = s.projects.ReadVersion(ctx, tx, versionID); err != nil {
			return err
		}
		rows, err = q.ListPlans(ctx, versionID)
		return err
	})
	if err != nil {
		return nil, err
	}
	out := make([]Plan, len(rows))
	for i, r := range rows {
		if out[i], err = s.planOf(ctx, actor, ref, store.GetPlanRow(r)); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// Get returns a plan with its lock.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (Plan, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return Plan{}, err
	}
	return s.detail(ctx, actor, id)
}

func (s *Service) detail(ctx context.Context, actor auth.Actor, id uuid.UUID) (Plan, error) {
	var (
		ref projects.VersionRef
		row store.GetPlanRow
	)
	err := s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
		var err error
		ref, err = s.readPlanVersion(ctx, actor, tx, q, id)
		if err != nil {
			return err
		}
		row, err = q.GetPlan(ctx, id)
		return notFound(err)
	})
	if err != nil {
		return Plan{}, err
	}
	return s.planOf(ctx, actor, ref, row)
}

// Create adds a plan with its image at the end of the version's plans.
func (s *Service) Create(ctx context.Context, versionID uuid.UUID, name string, image io.Reader) (Plan, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return Plan{}, err
	}
	name, err = validateName(name)
	if err != nil {
		return Plan{}, err
	}
	// The version's tenant scopes the image; a read-only project is refused
	// before the upload.
	var ref projects.VersionRef
	err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, _ *store.Queries) error {
		var err error
		ref, err = s.projects.ReadVersion(ctx, tx, versionID)
		return err
	})
	if err != nil {
		return Plan{}, err
	}
	if !ref.Writable() {
		return Plan{}, errReadOnly()
	}
	file, err := s.files.UploadImage(ctx, files.TenantScope(ref.TenantID), image, files.FloorplanImage)
	if err != nil {
		return Plan{}, err
	}
	var id uuid.UUID
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		ref, err := s.projects.WriteVersion(ctx, tx, versionID, true)
		if err != nil {
			return err
		}
		id, err = q.CreatePlan(ctx, store.CreatePlanParams{
			TenantID: ref.TenantID, VersionID: versionID, Name: name, ImageFileID: file.ID,
			ImageWidth: int32(file.Width), ImageHeight: int32(file.Height), //nolint:gosec // bounded by the image limits
		})
		return mapNameErr(err, name)
	})
	if err != nil {
		return Plan{}, err
	}
	return s.detail(ctx, actor, id)
}

// PlanUpdate renames a plan and optionally replaces its image.
type PlanUpdate struct {
	Name              string
	ExpectedUpdatedAt time.Time
	// Image is the new image, nil to keep the current one.
	Image io.Reader
}

// Update renames a plan or replaces its image (plan.stale if it changed
// since in.ExpectedUpdatedAt). A new image of another size scales the
// content to it (scaleContent, D194); replacing the image is refused while
// another user holds the edit lock (plan.locked).
func (s *Service) Update(ctx context.Context, id uuid.UUID, in PlanUpdate) (Plan, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return Plan{}, err
	}
	name, err := validateName(in.Name)
	if err != nil {
		return Plan{}, err
	}
	var current store.GetPlanRow
	var ref projects.VersionRef
	err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
		var err error
		if ref, err = s.readPlanVersion(ctx, actor, tx, q, id); err != nil {
			return err
		}
		current, err = q.GetPlan(ctx, id)
		return notFound(err)
	})
	if err != nil {
		return Plan{}, err
	}
	if !ref.Writable() {
		return Plan{}, errReadOnly()
	}
	if !current.UpdatedAt.Equal(in.ExpectedUpdatedAt) {
		return Plan{}, errStale()
	}
	var file *files.File
	if in.Image != nil {
		if err := s.checkLock(ctx, actor, current.LockUserID, current.LockExpiresAt); err != nil {
			return Plan{}, err
		}
		f, err := s.files.UploadImage(ctx, files.TenantScope(current.TenantID), in.Image, files.FloorplanImage)
		if err != nil {
			return Plan{}, err
		}
		file = &f
	}
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.WriteVersion(ctx, tx, current.VersionID, false); err != nil {
			return err
		}
		locked, err := q.LockPlan(ctx, id)
		if err != nil {
			return notFound(err)
		}
		if !locked.UpdatedAt.Equal(in.ExpectedUpdatedAt) {
			return errStale()
		}
		params := store.UpdatePlanParams{
			ID: id, Name: name, ImageFileID: locked.ImageFileID, ImageWidth: locked.ImageWidth, ImageHeight: locked.ImageHeight,
		}
		if file != nil {
			if err := s.checkLock(ctx, actor, locked.LockUserID, locked.LockExpiresAt); err != nil {
				return err
			}
			params.ImageFileID = file.ID
			params.ImageWidth, params.ImageHeight = int32(file.Width), int32(file.Height) //nolint:gosec // bounded by the image limits
			if err := s.scaleContent(ctx, q, locked, params.ImageWidth, params.ImageHeight); err != nil {
				return err
			}
		}
		return mapNameErr(q.UpdatePlan(ctx, params), name)
	})
	if err != nil {
		return Plan{}, err
	}
	return s.detail(ctx, actor, id)
}

// Delete removes a plan with its content; refused while another user holds
// the edit lock (plan.locked). The image file stays (D58).
func (s *Service) Delete(ctx context.Context, id uuid.UUID) error {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return err
	}
	return s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		versionID, err := s.planVersionID(ctx, actor, q, id)
		if err != nil {
			return err
		}
		if _, err := s.projects.WriteVersion(ctx, tx, versionID, true); err != nil {
			return err
		}
		locked, err := q.LockPlan(ctx, id)
		if err != nil {
			return notFound(err)
		}
		if err := s.checkLock(ctx, actor, locked.LockUserID, locked.LockExpiresAt); err != nil {
			return err
		}
		_, err = q.DeletePlan(ctx, id)
		return err
	})
}

// Reorder sets the order of a version's plans; ids must list every plan of
// the version exactly once (plan.order_mismatch).
func (s *Service) Reorder(ctx context.Context, versionID uuid.UUID, ids []uuid.UUID) ([]Plan, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return nil, err
	}
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.WriteVersion(ctx, tx, versionID, true); err != nil {
			return err
		}
		existing, err := q.PlanIDsOfVersion(ctx, versionID)
		if err != nil {
			return err
		}
		if !sameSet(ids, existing) {
			return apperr.New(http.StatusUnprocessableEntity, "plan.order_mismatch", "ids must list every plan of the version exactly once")
		}
		return q.SetPlanOrder(ctx, ids)
	})
	if err != nil {
		return nil, err
	}
	return s.List(ctx, versionID)
}

// imageURL is the download path of a plan's image. It names the file, so it
// changes when the image is replaced and the response can be cached forever
// (D211); the file id is only accepted for the plan's current image.
func imageURL(planID, fileID uuid.UUID) string {
	return "/api/plans/" + planID.String() + "/images/" + fileID.String()
}

// Image opens a plan's image for download. fileID must be the plan's current
// image (an old URL after a replacement is plan.image_not_found).
func (s *Service) Image(ctx context.Context, id, fileID uuid.UUID) (files.File, io.ReadSeekCloser, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return files.File{}, nil, err
	}
	err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.readPlanVersion(ctx, actor, tx, q, id); err != nil {
			return err
		}
		row, err := q.GetPlan(ctx, id)
		if err != nil {
			return notFound(err)
		}
		if row.ImageFileID != fileID {
			return apperr.NotFound("plan.image_not_found")
		}
		return nil
	})
	if err != nil {
		return files.File{}, nil, err
	}
	return s.files.OpenReferenced(ctx, fileID)
}

// ---------------------------------------------------------------- edit lock

// Lock takes or renews the caller's edit lock of a plan (LockTTL from now).
// A live lock of another user is plan.locked (with the holder's name and
// expiry), unless force and the caller may break locks (projects.delete).
func (s *Service) Lock(ctx context.Context, id uuid.UUID, force bool) (PlanLock, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return PlanLock{}, err
	}
	if force {
		if _, err := auth.Require(ctx, auth.PermProjectsDelete); err != nil {
			return PlanLock{}, err
		}
	}
	var expires time.Time
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		versionID, err := s.planVersionID(ctx, actor, q, id)
		if err != nil {
			return err
		}
		if _, err := s.projects.WriteVersion(ctx, tx, versionID, false); err != nil {
			return err
		}
		locked, err := q.LockPlan(ctx, id)
		if err != nil {
			return notFound(err)
		}
		if !force {
			if err := s.checkLock(ctx, actor, locked.LockUserID, locked.LockExpiresAt); err != nil {
				return err
			}
		}
		expires = s.now().Add(LockTTL).UTC().Truncate(time.Microsecond)
		return q.SetLock(ctx, store.SetLockParams{ID: id, LockUserID: &actor.UserID, LockExpiresAt: &expires})
	})
	if err != nil {
		return PlanLock{}, err
	}
	name, err := s.users.DisplayName(ctx, actor.UserID)
	if err != nil {
		return PlanLock{}, err
	}
	return PlanLock{UserID: actor.UserID, Name: name, ExpiresAt: expires, Mine: true}, nil
}

// Unlock releases the caller's edit lock; a lock of someone else (or none)
// stays as it is. Works also on read-only projects, so an editor can always
// let go.
func (s *Service) Unlock(ctx context.Context, id uuid.UUID) error {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return err
	}
	return s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.readPlanVersion(ctx, actor, tx, q, id); err != nil {
			return err
		}
		locked, err := q.LockPlan(ctx, id)
		if err != nil {
			return notFound(err)
		}
		if locked.LockUserID == nil || *locked.LockUserID != actor.UserID {
			return nil
		}
		return q.SetLock(ctx, store.SetLockParams{ID: id})
	})
}

// checkLock refuses a change while another user holds a live lock.
func (s *Service) checkLock(ctx context.Context, actor auth.Actor, userID *uuid.UUID, expires *time.Time) error {
	if !s.live(userID, expires) || *userID == actor.UserID {
		return nil
	}
	name, err := s.users.DisplayName(ctx, *userID)
	if err != nil {
		return err
	}
	return apperr.Conflict("plan.locked", "another user is editing the plan").
		With("name", name).With("expiresAt", expires.UTC().Format(time.RFC3339))
}

// requireLock refuses a content save without the caller's live lock.
func (s *Service) requireLock(actor auth.Actor, userID *uuid.UUID, expires *time.Time) error {
	if s.live(userID, expires) && *userID == actor.UserID {
		return nil
	}
	return apperr.Conflict("plan.lock_required", "open the plan for editing (take its lock) first")
}

func (s *Service) live(userID *uuid.UUID, expires *time.Time) bool {
	return userID != nil && expires != nil && expires.After(s.now())
}

// ---------------------------------------------------------------- helpers

// planVersionID returns the version of a plan the caller sees.
func (s *Service) planVersionID(ctx context.Context, actor auth.Actor, q *store.Queries, id uuid.UUID) (uuid.UUID, error) {
	row, err := q.GetPlan(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !actor.SeesTenant(row.TenantID)) {
		return uuid.Nil, errNotFound()
	}
	return row.VersionID, err
}

// readPlanVersion returns the version of a plan the caller may read.
func (s *Service) readPlanVersion(ctx context.Context, actor auth.Actor, tx pgx.Tx, q *store.Queries, id uuid.UUID) (projects.VersionRef, error) {
	versionID, err := s.planVersionID(ctx, actor, q, id)
	if err != nil {
		return projects.VersionRef{}, err
	}
	return s.projects.ReadVersion(ctx, tx, versionID)
}

func (s *Service) planOf(ctx context.Context, actor auth.Actor, ref projects.VersionRef, r store.GetPlanRow) (Plan, error) {
	write := actor.Can(auth.PermProjectsWrite) && ref.Writable()
	p := Plan{
		ID: r.ID, VersionID: r.VersionID, ProjectID: ref.ProjectID, Kind: r.Kind, Name: r.Name, Position: r.Position,
		Image: PlanImage{
			URL: imageURL(r.ID, r.ImageFileID), Width: r.ImageWidth, Height: r.ImageHeight,
		},
		Scale: r.Scale, ZoneCount: r.ZoneCount, PlacementCount: r.PlacementCount,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt, ContentUpdatedAt: r.ContentUpdatedAt,
		Can: PlanActions{Update: write, BreakLock: write && actor.Can(auth.PermProjectsDelete)},
	}
	if s.live(r.LockUserID, r.LockExpiresAt) {
		name, err := s.users.DisplayName(ctx, *r.LockUserID)
		if err != nil {
			return Plan{}, err
		}
		p.Lock = &NullablePlanLock{PlanLock: PlanLock{UserID: *r.LockUserID, Name: name, ExpiresAt: *r.LockExpiresAt, Mine: *r.LockUserID == actor.UserID}}
	}
	return p, nil
}

func validateName(name string) (string, error) {
	name = strings.TrimSpace(name)
	switch {
	case name == "":
		return "", apperr.Invalid("body.name", "validation.required", "required")
	case len([]rune(name)) > MaxNameLength:
		return "", apperr.Validation(apperr.Field("body.name", "validation.too_long", "too long").With("max", MaxNameLength))
	case strings.ContainsFunc(name, unicode.IsControl):
		return "", apperr.Invalid("body.name", "validation.control_chars", "control characters are not allowed")
	}
	return name, nil
}

// sameSet reports whether ids holds every id of existing exactly once.
func sameSet(ids, existing []uuid.UUID) bool {
	if len(ids) != len(existing) {
		return false
	}
	want := make(map[uuid.UUID]bool, len(existing))
	for _, id := range existing {
		want[id] = true
	}
	for _, id := range ids {
		if !want[id] {
			return false
		}
		delete(want, id)
	}
	return true
}

func notFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound()
	}
	return err
}

func mapNameErr(err error, name string) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "plans_name_key" {
		return apperr.Conflict("plan.name_taken", "the version already has a plan of this name").With("name", name)
	}
	return err
}

func errNotFound() *apperr.Error { return apperr.NotFound("plan.not_found") }

func errStale() *apperr.Error {
	return apperr.Conflict("plan.stale", "the plan was changed by someone else")
}

func errReadOnly() *apperr.Error {
	return apperr.Conflict("project.read_only", "the project is completed or cancelled; reopen it first")
}
