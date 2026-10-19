package projects

// What other features that own data of a version (plans first) use: access
// checks of a version in their own transaction and the version copy hook.
// They never read the project tables themselves (CLAUDE.md rule 3).

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/projects/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

// VersionRef is a version as other features see it.
type VersionRef struct {
	ID        uuid.UUID
	ProjectID uuid.UUID
	TenantID  uuid.UUID
	Status    ProjectStatus
	// ProductTypeIDs are the product types the project uses (filled by
	// ReadVersion and WriteVersion).
	ProductTypeIDs []uuid.UUID
	// Currency (ISO 4217) and ExchangeRate (units per 1 USD, decimal
	// string) of the project (filled by ReadVersion and WriteVersion).
	Currency     string
	ExchangeRate string
}

// Writable reports whether the version's project takes changes (active).
func (v VersionRef) Writable() bool { return v.Status == StatusActive }

// VersionCopier copies what a feature owns of source to target, in tx (the
// transaction that creates target, scoped to the caller). A failure fails
// the version create.
type VersionCopier func(ctx context.Context, tx pgx.Tx, source, target VersionRef) error

// OnCopyVersion registers a copier; CreateVersion runs every copier when it
// copies a version. Call it while wiring the features, not concurrently with
// requests.
func (s *Service) OnCopyVersion(c VersionCopier) { s.copiers = append(s.copiers, c) }

// VersionsDeleter runs in tx, the transaction that deletes versions (one
// version or a whole project), before their rows and everything that
// cascades with them go. It returns what to run once that transaction has
// committed (nil: nothing), e.g. deleting files only the deleted rows
// referenced (D269). A failure fails the delete.
type VersionsDeleter func(ctx context.Context, tx pgx.Tx, versionIDs []uuid.UUID) (after func(context.Context), err error)

// OnDeleteVersions registers a deleter; Delete and DeleteVersion run every
// deleter. Call it while wiring the features, not concurrently with
// requests.
func (s *Service) OnDeleteVersions(d VersionsDeleter) { s.deleters = append(s.deleters, d) }

// deleteVersions runs the deleters for versions in tx and returns what to
// run after the commit.
func (s *Service) deleteVersions(ctx context.Context, tx pgx.Tx, versionIDs []uuid.UUID) ([]func(context.Context), error) {
	var after []func(context.Context)
	for _, d := range s.deleters {
		a, err := d(ctx, tx, versionIDs)
		if err != nil {
			return nil, err
		}
		if a != nil {
			after = append(after, a)
		}
	}
	return after, nil
}

// ReadVersion returns a version the caller may read (projects.read), in tx,
// a transaction scoped to the caller (database.InScope). Versions of
// projects the caller does not see are project_version.not_found.
func (s *Service) ReadVersion(ctx context.Context, tx pgx.Tx, id uuid.UUID) (VersionRef, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return VersionRef{}, err
	}
	q := s.q.WithTx(tx)
	return versionRef(ctx, actor, q, q.VersionAccess, id)
}

// WriteVersion returns a version the caller may change (projects.write, the
// project active, else project.read_only), in tx (see ReadVersion), and
// locks its project until tx ends: exclusive (FOR UPDATE: orders creates,
// reorders and deletes of the version's plans) or shared (FOR SHARE: orders a
// content save against a status change).
func (s *Service) WriteVersion(ctx context.Context, tx pgx.Tx, id uuid.UUID, exclusive bool) (VersionRef, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return VersionRef{}, err
	}
	q := s.q.WithTx(tx)
	get := q.VersionAccessShare
	if exclusive {
		get = func(ctx context.Context, id uuid.UUID) (store.VersionAccessShareRow, error) {
			r, err := q.VersionAccessLock(ctx, id)
			return store.VersionAccessShareRow(r), err
		}
	}
	v, err := versionRef(ctx, actor, q, func(ctx context.Context, id uuid.UUID) (store.VersionAccessRow, error) {
		r, err := get(ctx, id)
		return store.VersionAccessRow(r), err
	}, id)
	if err != nil {
		return v, err
	}
	if !v.Writable() {
		return v, errReadOnly()
	}
	return v, nil
}

func versionRef(ctx context.Context, actor auth.Actor, q *store.Queries, get func(context.Context, uuid.UUID) (store.VersionAccessRow, error), id uuid.UUID) (VersionRef, error) {
	r, err := get(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !actor.SeesTenant(r.TenantID)) {
		return VersionRef{}, apperr.NotFound("project_version.not_found")
	}
	if err != nil {
		return VersionRef{}, err
	}
	types, err := typesOf(ctx, q, r.ProjectID)
	if err != nil {
		return VersionRef{}, err
	}
	return VersionRef{ID: r.ID, ProjectID: r.ProjectID, TenantID: r.TenantID, Status: ProjectStatus(r.Status), ProductTypeIDs: types,
		Currency: r.Currency, ExchangeRate: r.ExchangeRate}, nil
}
