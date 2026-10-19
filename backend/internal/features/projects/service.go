// Package projects manages projects and their versions, the first
// tenant-owned business data. A project belongs to one tenant, has a
// generated number (<year>-<sequence of the tenant in that year>), an
// embedded customer, the product types (systems) it uses and at least one
// version. Versions are alternative offers or rounds of changes; a new one is
// always a full copy of an existing one.
//
// Every database access runs in database.InScope, so row-level security
// limits it to the tenants the caller sees; the service checks tenants too
// (actor.SeesTenant), so other tenants' projects are 404. Completed and
// cancelled projects are read-only (project.read_only) until set back to
// active. Product types are read through producttypes.Service and tenants
// through tenants.Service; this feature never reads their tables.
package projects

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/features/projects/store"
	"github.com/kingkill85/snapflow/backend/internal/features/tenants"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/exchangerate"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
	"github.com/kingkill85/snapflow/backend/internal/platform/money"
)

var (
	currencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)
	// ratePattern: up to 8 digits before the point and 6 after (numeric(14,6)).
	ratePattern = regexp.MustCompile(`^\d{1,8}(\.\d{1,6})?$`)
)

// DB is the database the service runs on; *pgxpool.Pool implements it.
type DB interface {
	store.DBTX
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

type Service struct {
	db DB
	q  *store.Queries
	// copiers copy what other features own of a version (OnCopyVersion).
	copiers []VersionCopier
	// deleters clean up what other features own of deleted versions
	// (OnDeleteVersions).
	deleters []VersionsDeleter
	types    *producttypes.Service
	tenants  *tenants.Service
	// now is the clock of project numbers (their year, in UTC).
	now func() time.Time
	// rates fetches online exchange rates; maxRateAge is when an online
	// rate counts as stale (days).
	rates      *exchangerate.Client
	maxRateAge int
}

func NewService(db DB, types *producttypes.Service, tenants *tenants.Service) *Service {
	return &Service{db: db, q: store.New(db), types: types, tenants: tenants, now: time.Now,
		rates: exchangerate.New(nil), maxRateAge: DefaultMaxRateAgeDays}
}

// UseExchangeRates sets the online exchange rates and the age (days) after
// which an online rate is stale. Call it while wiring the features.
func (s *Service) UseExchangeRates(c *exchangerate.Client, maxAgeDays int) {
	s.rates = c
	if maxAgeDays > 0 {
		s.maxRateAge = maxAgeDays
	}
}

// inScope runs fn in one transaction scoped to actor (row-level security,
// database.InScope).
func (s *Service) inScope(ctx context.Context, actor auth.Actor, opts pgx.TxOptions, fn func(q *store.Queries) error) error {
	return database.InScope(ctx, s.db, actor, opts, func(tx pgx.Tx) error { return fn(s.q.WithTx(tx)) })
}

// ---------------------------------------------------------------- projects

// List returns one page of the projects the caller sees, newest change
// first. Callers who see every tenant may filter by tenant; everyone else
// gets their own tenant.
func (s *Service) List(ctx context.Context, p ListParams) (ProjectPage, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return ProjectPage{}, err
	}
	status, err := listStatus(p.Status)
	if err != nil {
		return ProjectPage{}, err
	}
	if err := checkPage(p.Limit, p.Offset); err != nil {
		return ProjectPage{}, err
	}
	tenantID := p.TenantID
	if !actor.Can(auth.PermTenantsAccessAll) {
		tenantID = &actor.TenantID
	}
	pattern := likePattern(p.Search)
	var (
		rows  []store.ListProjectsRow
		total int64
		links []store.ListProductTypesOfProjectsRow
	)
	err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(q *store.Queries) error {
		var err error
		rows, err = q.ListProjects(ctx, store.ListProjectsParams{
			TenantID: tenantID, Status: status, Search: pattern,
			RowLimit: int32(p.Limit), RowOffset: int32(p.Offset), //nolint:gosec // checked by checkPage
		})
		if err != nil {
			return err
		}
		total, err = q.CountProjects(ctx, store.CountProjectsParams{TenantID: tenantID, Status: status, Search: pattern})
		if err != nil {
			return err
		}
		ids := make([]uuid.UUID, len(rows))
		for i, r := range rows {
			ids[i] = r.ID
		}
		links, err = q.ListProductTypesOfProjects(ctx, ids)
		return err
	})
	if err != nil {
		return ProjectPage{}, err
	}
	order, err := s.typeOrder(ctx)
	if err != nil {
		return ProjectPage{}, err
	}
	typesOf := map[uuid.UUID][]uuid.UUID{}
	for _, l := range links {
		typesOf[l.ProjectID] = append(typesOf[l.ProjectID], l.ProductTypeID)
	}
	tenantIDs := make([]uuid.UUID, len(rows))
	for i, r := range rows {
		tenantIDs[i] = r.TenantID
	}
	refs, err := s.tenantRefs(ctx, actor, tenantIDs)
	if err != nil {
		return ProjectPage{}, err
	}
	items := make([]ProjectListItem, 0, len(rows))
	for _, r := range rows {
		ref := refs[r.TenantID]
		items = append(items, ProjectListItem{
			ID: r.ID, TenantID: r.TenantID, Tenant: ref, Number: r.Number, Name: r.Name,
			CustomerName: r.CustomerName, CustomerCompany: r.CustomerCompany, Status: ProjectStatus(r.Status),
			VersionCount: r.VersionCount, ProductTypeIDs: order.sort(typesOf[r.ID]), UpdatedAt: r.UpdatedAt,
			Can: projectActions(actor, ProjectStatus(r.Status)),
		})
	}
	return ProjectPage{Items: items, Total: total}, nil
}

// Get returns a project with its versions.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (Project, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return Project{}, err
	}
	return s.detail(ctx, actor, id)
}

func (s *Service) detail(ctx context.Context, actor auth.Actor, id uuid.UUID) (Project, error) {
	var (
		row      store.Project
		versions []store.ProjectVersion
		links    []store.ListProductTypesOfProjectsRow
	)
	err := s.inScope(ctx, actor, database.ReadOnlySnapshot, func(q *store.Queries) error {
		var err error
		row, err = visible(ctx, actor, q.GetProject, id)
		if err != nil {
			return err
		}
		versions, err = q.ListVersions(ctx, id)
		if err != nil {
			return err
		}
		links, err = q.ListProductTypesOfProjects(ctx, []uuid.UUID{id})
		return err
	})
	if err != nil {
		return Project{}, err
	}
	order, err := s.typeOrder(ctx)
	if err != nil {
		return Project{}, err
	}
	refs, err := s.tenantRefs(ctx, actor, []uuid.UUID{row.TenantID})
	if err != nil {
		return Project{}, err
	}
	ref := refs[row.TenantID]
	typeIDs := make([]uuid.UUID, len(links))
	for i, l := range links {
		typeIDs[i] = l.ProductTypeID
	}
	can := projectActions(actor, ProjectStatus(row.Status))
	p := Project{
		ID: row.ID, TenantID: row.TenantID, Tenant: ref, Number: row.Number, Name: row.Name,
		Status: ProjectStatus(row.Status), Language: row.Language, Currency: row.Currency,
		Customer: ProjectCustomer{
			Name: row.CustomerName, Company: row.CustomerCompany, Email: row.CustomerEmail,
			Phone: row.CustomerPhone, Address: row.CustomerAddress,
		},
		Notes: row.Notes, ProductTypeIDs: order.sort(typeIDs), Versions: make([]ProjectVersion, len(versions)),
		NextVersionName: nextVersionName(versions),
		CreatedBy:       row.CreatedBy, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt, Can: can,
	}
	for i, v := range versions {
		p.Versions[i] = versionOf(v, can, len(versions))
	}
	s.setRate(&p, row)
	return p, nil
}

// Create adds a project in the caller's tenant (or, for callers who see
// every tenant, the chosen one) with one version, V1.
func (s *Service) Create(ctx context.Context, in ProjectCreate) (Project, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return Project{}, err
	}
	tenantID, err := s.resolveTenant(ctx, actor, in.TenantID, nil)
	if err != nil {
		return Project{}, err
	}
	v, err := s.validate(ctx, in.ProjectInput, nil, nil)
	if err != nil {
		return Project{}, err
	}
	var id uuid.UUID
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(q *store.Queries) error {
		number, err := s.nextNumber(ctx, q, tenantID)
		if err != nil {
			return err
		}
		createdBy := actor.UserID
		row, err := q.CreateProject(ctx, store.CreateProjectParams{
			TenantID: tenantID, Number: number, Name: v.name, Language: v.language, Currency: v.currency,
			ExchangeRate: v.rate.rate, ExchangeRateDate: v.rate.date, ExchangeRateSource: v.rate.source,
			ExchangeRateProvider: v.rate.provider, CustomerName: v.customer.Name, CustomerCompany: v.customer.Company,
			CustomerEmail: v.customer.Email, CustomerPhone: v.customer.Phone, CustomerAddress: v.customer.Address,
			Notes: v.notes, CreatedBy: &createdBy,
		})
		if err != nil {
			return err
		}
		id = row.ID
		if err := q.AddProductTypesToProject(ctx, store.AddProductTypesToProjectParams{
			TenantID: tenantID, ProjectID: id, ProductTypeIds: v.typeIDs,
		}); err != nil {
			return err
		}
		_, err = q.CreateVersion(ctx, store.CreateVersionParams{TenantID: tenantID, ProjectID: id, Name: FirstVersionName})
		return err
	})
	if err != nil {
		return Project{}, mapRefErr(err)
	}
	return s.detail(ctx, actor, id)
}

// Update changes a project; project.stale if it changed since
// in.ExpectedUpdatedAt. A completed or cancelled project only accepts an
// update that sets it back to active (project.read_only otherwise). Moving
// it to another tenant gives it a new number there.
func (s *Service) Update(ctx context.Context, id uuid.UUID, in ProjectUpdate) (Project, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return Project{}, err
	}
	if !slices.Contains([]ProjectStatus{StatusActive, StatusCompleted, StatusCancelled}, in.Status) {
		return Project{}, apperr.Invalid("body.status", "validation.invalid", "unknown status")
	}
	// Read first (outside the transaction) to validate against the current
	// state; the transaction checks the version again under the lock.
	var current store.Project
	var currentTypes []uuid.UUID
	err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(q *store.Queries) error {
		var err error
		current, err = visible(ctx, actor, q.GetProject, id)
		if err != nil {
			return err
		}
		currentTypes, err = typesOf(ctx, q, id)
		return err
	})
	if err != nil {
		return Project{}, err
	}
	if !current.UpdatedAt.Equal(in.ExpectedUpdatedAt) {
		return Project{}, errStale()
	}
	if ProjectStatus(current.Status) != StatusActive && in.Status != StatusActive {
		return Project{}, errReadOnly()
	}
	tenantID, err := s.resolveTenant(ctx, actor, in.TenantID, &current.TenantID)
	if err != nil {
		return Project{}, err
	}
	v, err := s.validate(ctx, in.ProjectInput, &current, currentTypes)
	if err != nil {
		return Project{}, err
	}
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(q *store.Queries) error {
		locked, err := visible(ctx, actor, q.LockProject, id)
		if err != nil {
			return err
		}
		if !locked.UpdatedAt.Equal(in.ExpectedUpdatedAt) {
			return errStale()
		}
		number := locked.Number
		if tenantID != locked.TenantID {
			if number, err = s.nextNumber(ctx, q, tenantID); err != nil {
				return err
			}
		}
		if _, err := q.UpdateProject(ctx, store.UpdateProjectParams{
			ID: id, TenantID: tenantID, Number: number, Name: v.name, Status: string(in.Status),
			Language: v.language, Currency: v.currency, ExchangeRate: v.rate.rate, ExchangeRateDate: v.rate.date,
			ExchangeRateSource: v.rate.source, ExchangeRateProvider: v.rate.provider,
			CustomerName: v.customer.Name, CustomerCompany: v.customer.Company, CustomerEmail: v.customer.Email,
			CustomerPhone: v.customer.Phone, CustomerAddress: v.customer.Address, Notes: v.notes,
		}); err != nil {
			return err
		}
		if sameSet(v.typeIDs, currentTypes) {
			return nil
		}
		if err := q.DeleteProductTypesOfProject(ctx, id); err != nil {
			return err
		}
		return q.AddProductTypesToProject(ctx, store.AddProductTypesToProjectParams{
			TenantID: tenantID, ProjectID: id, ProductTypeIds: v.typeIDs,
		})
	})
	if err != nil {
		return Project{}, mapRefErr(err)
	}
	return s.detail(ctx, actor, id)
}

// Delete removes a project with everything it owns (versions, product type
// choices, plans, proposals); proposal files nothing else references are
// deleted after the commit (D269), other files stay (D58). Needs
// projects.delete, whatever the project's status.
func (s *Service) Delete(ctx context.Context, id uuid.UUID) error {
	actor, err := auth.Require(ctx, auth.PermProjectsDelete)
	if err != nil {
		return err
	}
	var after []func(context.Context)
	err = database.InScope(ctx, s.db, actor, pgx.TxOptions{}, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if _, err := visible(ctx, actor, q.LockProject, id); err != nil {
			return err
		}
		versions, err := q.ListVersions(ctx, id)
		if err != nil {
			return err
		}
		ids := make([]uuid.UUID, len(versions))
		for i, v := range versions {
			ids[i] = v.ID
		}
		if after, err = s.deleteVersions(ctx, tx, ids); err != nil {
			return err
		}
		n, err := q.DeleteProject(ctx, id)
		if err != nil {
			return err
		}
		if n == 0 {
			return errNotFound()
		}
		return nil
	})
	if err != nil {
		return err
	}
	for _, a := range after {
		a(ctx)
	}
	return nil
}

// CountByTenant counts the projects of tenants (for the tenants feature:
// archive instead of delete). Tenants the caller does not see count 0.
func (s *Service) CountByTenant(ctx context.Context, tenantIDs []uuid.UUID) (map[uuid.UUID]int64, error) {
	actor, err := auth.Require(ctx)
	if err != nil {
		return nil, err
	}
	var rows []store.CountProjectsByTenantRow
	err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(q *store.Queries) error {
		var err error
		rows, err = q.CountProjectsByTenant(ctx, tenantIDs)
		return err
	})
	if err != nil {
		return nil, err
	}
	out := make(map[uuid.UUID]int64, len(rows))
	for _, r := range rows {
		out[r.TenantID] = r.ProjectCount
	}
	return out, nil
}

// ---------------------------------------------------------------- versions

// CreateVersion adds a version: a full copy of in.SourceVersionID (the
// default in the UI) or, without it, an empty one.
func (s *Service) CreateVersion(ctx context.Context, projectID uuid.UUID, in ProjectVersionCreate) (ProjectVersion, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return ProjectVersion{}, err
	}
	name, err := validateVersionName(in.Name)
	if err != nil {
		return ProjectVersion{}, err
	}
	var (
		row   store.ProjectVersion
		count int64
	)
	err = database.InScope(ctx, s.db, actor, pgx.TxOptions{}, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		project, err := s.writable(ctx, actor, q, projectID)
		if err != nil {
			return err
		}
		var source *store.ProjectVersion
		if in.SourceVersionID != nil {
			v, err := q.GetVersion(ctx, store.GetVersionParams{ID: *in.SourceVersionID, ProjectID: projectID})
			if errors.Is(err, pgx.ErrNoRows) {
				return apperr.Invalid("body.sourceVersionId", "project_version.not_found", "no such version in this project")
			}
			if err != nil {
				return err
			}
			source = &v
		}
		params := store.CreateVersionParams{TenantID: project.TenantID, ProjectID: projectID, Name: name}
		if source != nil {
			params.Notes = source.Notes
		}
		row, err = q.CreateVersion(ctx, params)
		if err != nil {
			return mapVersionErr(err, name)
		}
		if source != nil {
			if err := s.copyVersion(ctx, tx, *source, row); err != nil {
				return err
			}
		}
		count, err = q.CountVersions(ctx, projectID)
		return err
	})
	if err != nil {
		return ProjectVersion{}, err
	}
	return versionOf(row, projectActions(actor, StatusActive), int(count)), nil
}

// copyVersion copies everything a version owns from source to target, in
// the transaction that created target: the row itself is copied by
// CreateVersion, the tables of other features (2b: plans with zones and
// placements; 2c: pricing settings) by the copiers they registered.
func (s *Service) copyVersion(ctx context.Context, tx pgx.Tx, source, target store.ProjectVersion) error {
	src := VersionRef{ID: source.ID, ProjectID: source.ProjectID, TenantID: source.TenantID, Status: StatusActive}
	dst := VersionRef{ID: target.ID, ProjectID: target.ProjectID, TenantID: target.TenantID, Status: StatusActive}
	for _, c := range s.copiers {
		if err := c(ctx, tx, src, dst); err != nil {
			return err
		}
	}
	return nil
}

// UpdateVersion renames a version or changes its notes;
// project_version.stale if it changed since in.ExpectedUpdatedAt.
func (s *Service) UpdateVersion(ctx context.Context, projectID, id uuid.UUID, in ProjectVersionUpdate) (ProjectVersion, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return ProjectVersion{}, err
	}
	name, err := validateVersionName(in.Name)
	if err != nil {
		return ProjectVersion{}, err
	}
	// Notes left out keep the stored ones; an empty string clears them.
	var notes *string
	if in.Notes != nil {
		n, ferr := multiLine("body.notes", *in.Notes, MaxVersionNotesLength)
		if ferr != nil {
			return ProjectVersion{}, apperr.Validation(*ferr)
		}
		notes = &n
	}
	var (
		row   store.ProjectVersion
		count int64
	)
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(q *store.Queries) error {
		if _, err := s.writable(ctx, actor, q, projectID); err != nil {
			return err
		}
		current, err := q.GetVersion(ctx, store.GetVersionParams{ID: id, ProjectID: projectID})
		if err != nil {
			return mapVersionErr(err, name)
		}
		if !current.UpdatedAt.Equal(in.ExpectedUpdatedAt) {
			return apperr.Conflict("project_version.stale", "the version was changed by someone else")
		}
		params := store.UpdateVersionParams{ID: id, ProjectID: projectID, Name: name, Notes: current.Notes}
		if notes != nil {
			params.Notes = *notes
		}
		row, err = q.UpdateVersion(ctx, params)
		if err != nil {
			return mapVersionErr(err, name)
		}
		count, err = q.CountVersions(ctx, projectID)
		return err
	})
	if err != nil {
		return ProjectVersion{}, err
	}
	return versionOf(row, projectActions(actor, StatusActive), int(count)), nil
}

// DeleteVersion removes a version with everything it owns; like Delete,
// it deletes proposal files nothing else references after the commit
// (D269). The last version cannot be deleted (project_version.last): delete
// the project instead.
func (s *Service) DeleteVersion(ctx context.Context, projectID, id uuid.UUID) error {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return err
	}
	var after []func(context.Context)
	err = database.InScope(ctx, s.db, actor, pgx.TxOptions{}, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		if _, err := s.writable(ctx, actor, q, projectID); err != nil {
			return err
		}
		if _, err := q.GetVersion(ctx, store.GetVersionParams{ID: id, ProjectID: projectID}); err != nil {
			return mapVersionErr(err, "")
		}
		count, err := q.CountVersions(ctx, projectID)
		if err != nil {
			return err
		}
		if count <= 1 {
			return apperr.Conflict("project_version.last", "the last version cannot be deleted; delete the project instead")
		}
		if after, err = s.deleteVersions(ctx, tx, []uuid.UUID{id}); err != nil {
			return err
		}
		_, err = q.DeleteVersion(ctx, store.DeleteVersionParams{ID: id, ProjectID: projectID})
		return err
	})
	if err != nil {
		return err
	}
	for _, a := range after {
		a(ctx)
	}
	return nil
}

// writable locks a project the caller sees for a change of its versions and
// refuses read-only ones. The lock orders version changes of one project
// (positions, the last-version rule) and a status change against them.
func (s *Service) writable(ctx context.Context, actor auth.Actor, q *store.Queries, id uuid.UUID) (store.Project, error) {
	p, err := visible(ctx, actor, q.LockProject, id)
	if err != nil {
		return p, err
	}
	if ProjectStatus(p.Status) != StatusActive {
		return p, errReadOnly()
	}
	return p, nil
}

// ---------------------------------------------------------------- helpers

// visible reads a project with get and hides projects of tenants the actor
// does not see (row-level security hides them too).
func visible(ctx context.Context, actor auth.Actor, get func(context.Context, uuid.UUID) (store.Project, error), id uuid.UUID) (store.Project, error) {
	p, err := get(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !actor.SeesTenant(p.TenantID)) {
		return store.Project{}, errNotFound()
	}
	return p, err
}

func typesOf(ctx context.Context, q *store.Queries, id uuid.UUID) ([]uuid.UUID, error) {
	links, err := q.ListProductTypesOfProjects(ctx, []uuid.UUID{id})
	if err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, len(links))
	for i, l := range links {
		ids[i] = l.ProductTypeID
	}
	return ids, nil
}

// nextNumber draws the tenant's next project number of the current year
// (UTC).
func (s *Service) nextNumber(ctx context.Context, q *store.Queries, tenantID uuid.UUID) (string, error) {
	year := s.now().UTC().Year()
	n, err := q.NextProjectNumber(ctx, store.NextProjectNumberParams{TenantID: tenantID, Year: int32(year)}) //nolint:gosec // a calendar year
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%d-%04d", year, n), nil
}

// resolveTenant returns the tenant a project goes to: the requested one, or
// current (update) or the caller's (create). Another tenant needs
// tenants.access_all; it must exist and not be archived, unless the project
// is already in it.
func (s *Service) resolveTenant(ctx context.Context, actor auth.Actor, requested, current *uuid.UUID) (uuid.UUID, error) {
	id := actor.TenantID
	if current != nil {
		id = *current
	}
	if requested != nil {
		id = *requested
	}
	if current != nil && id == *current {
		return id, nil
	}
	if !actor.SeesTenant(id) {
		return id, apperr.New(http.StatusForbidden, "project.tenant_forbidden", "you cannot place projects in another tenant")
	}
	t, err := s.tenants.Lookup(ctx, id)
	var ae *apperr.Error
	if (errors.As(err, &ae) && ae.Status == http.StatusNotFound) || (err == nil && t.ArchivedAt != nil) {
		return id, apperr.Invalid("body.tenantId", "project.tenant_not_found", "tenant does not exist")
	}
	return id, err
}

type validated struct {
	name, language, currency, notes string
	rate                            rateValue
	customer                        ProjectCustomer
	typeIDs                         []uuid.UUID
}

// validate checks and normalises the input. current and currentTypes are the
// project as stored (update) or nil (create): on update an empty language,
// currency or exchange rate keeps the stored value, and so do a missing
// product type list, customer field or notes; chosen product types that were
// inactive stay allowed.
func (s *Service) validate(ctx context.Context, in ProjectInput, current *store.Project, currentTypes []uuid.UUID) (validated, error) {
	var errs []apperr.FieldError
	add := func(f *apperr.FieldError) {
		if f != nil {
			errs = append(errs, *f)
		}
	}
	var v validated
	var f *apperr.FieldError
	v.name, f = singleLine("body.name", in.Name, MaxNameLength, true)
	add(f)
	// A customer field or notes left out keep the stored value (create:
	// empty); an empty string clears it (D170).
	var stored ProjectCustomer
	storedNotes := ""
	if current != nil {
		stored = ProjectCustomer{
			Name: current.CustomerName, Company: current.CustomerCompany, Email: current.CustomerEmail,
			Phone: current.CustomerPhone, Address: current.CustomerAddress,
		}
		storedNotes = current.Notes
	}
	var c ProjectCustomerInput
	if in.Customer != nil {
		c = *in.Customer
	}
	v.customer = stored
	if c.Name != nil {
		v.customer.Name, f = singleLine("body.customer.name", *c.Name, MaxCustomerNameLength, false)
		add(f)
	}
	if c.Company != nil {
		v.customer.Company, f = singleLine("body.customer.company", *c.Company, MaxCustomerCompanyLength, false)
		add(f)
	}
	if c.Phone != nil {
		v.customer.Phone, f = singleLine("body.customer.phone", *c.Phone, MaxCustomerPhoneLength, false)
		add(f)
	}
	if c.Email != nil {
		v.customer.Email, f = singleLine("body.customer.email", *c.Email, MaxCustomerEmailLength, false)
		add(f)
		if f == nil && v.customer.Email != "" && !validEmail(v.customer.Email) {
			errs = append(errs, apperr.Field("body.customer.email", "validation.email", "not a valid email address"))
		}
	}
	if c.Address != nil {
		v.customer.Address, f = multiLine("body.customer.address", *c.Address, MaxCustomerAddressLength)
		add(f)
	}
	v.notes = storedNotes
	if in.Notes != nil {
		v.notes, f = multiLine("body.notes", *in.Notes, MaxNotesLength)
		add(f)
	}

	v.language, v.currency = in.Language, strings.TrimSpace(in.Currency)
	if current != nil {
		v.language = cmpOr(v.language, current.Language)
		v.currency = cmpOr(v.currency, current.Currency)
	}
	v.language = cmpOr(v.language, i18n.DefaultLocale)
	v.currency = cmpOr(v.currency, DefaultCurrency)
	if !i18n.IsLocale(v.language) {
		errs = append(errs, apperr.Field("body.language", "validation.locale", "not a content language"))
	}
	switch {
	case !currencyPattern.MatchString(v.currency):
		errs = append(errs, apperr.Field("body.currency", "project.currency_format", "use a three-letter ISO 4217 code"))
	case (current == nil || v.currency != current.Currency) && !money.IsCurrency(v.currency):
		errs = append(errs, apperr.Field("body.currency", "project.currency_unknown", "not a supported ISO 4217 currency").With("currency", v.currency))
	default:
		r, f, err := s.validateRate(ctx, v.currency, in, current)
		if err != nil {
			return v, err
		}
		add(f)
		v.rate = r
	}

	typeErrs, err := s.validateTypes(ctx, &v, in.ProductTypeIDs, current != nil, currentTypes)
	if err != nil {
		return v, err
	}
	errs = append(errs, typeErrs...)
	if len(errs) > 0 {
		return v, apperr.Validation(errs...)
	}
	return v, nil
}

// validateTypes sets v.typeIDs: every active type when a create sends none,
// the current ones when an update sends none, else the sent ones (without
// duplicates). Each must exist; types not chosen before must be active.
func (s *Service) validateTypes(ctx context.Context, v *validated, ids []uuid.UUID, update bool, currentTypes []uuid.UUID) ([]apperr.FieldError, error) {
	all, err := s.types.List(ctx, true)
	if err != nil {
		return nil, err
	}
	if ids == nil {
		if update {
			v.typeIDs = currentTypes
			return nil, nil
		}
		for _, t := range all {
			if t.IsActive {
				v.typeIDs = append(v.typeIDs, t.ID)
			}
		}
		if len(v.typeIDs) == 0 {
			return []apperr.FieldError{apperr.Field("body.productTypeIds", "project.product_types_required", "choose at least one product type")}, nil
		}
		return nil, nil
	}
	if len(ids) == 0 {
		return []apperr.FieldError{apperr.Field("body.productTypeIds", "project.product_types_required", "choose at least one product type")}, nil
	}
	if len(ids) > MaxProductTypes {
		return []apperr.FieldError{apperr.Field("body.productTypeIds", "validation.too_many", "too many product types").With("max", MaxProductTypes)}, nil
	}
	byID := make(map[uuid.UUID]producttypes.ProductType, len(all))
	for _, t := range all {
		byID[t.ID] = t
	}
	var errs []apperr.FieldError
	seen := map[uuid.UUID]bool{}
	for i, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		loc := fmt.Sprintf("body.productTypeIds[%d]", i)
		t, ok := byID[id]
		switch {
		case !ok:
			errs = append(errs, apperr.Field(loc, "project.product_type_not_found", "no such product type"))
		case !t.IsActive && !slices.Contains(currentTypes, id):
			errs = append(errs, apperr.Field(loc, "project.product_type_inactive", "the product type is inactive"))
		default:
			v.typeIDs = append(v.typeIDs, id)
		}
	}
	return errs, nil
}

func validateVersionName(name string) (string, error) {
	n, f := singleLine("body.name", name, MaxVersionNameLength, true)
	if f != nil {
		return "", apperr.Validation(*f)
	}
	return n, nil
}

// singleLine trims s and checks its length and that it has no control
// characters.
func singleLine(loc, s string, maxLen int, required bool) (string, *apperr.FieldError) {
	s = strings.TrimSpace(s)
	switch {
	case required && s == "":
		f := apperr.Field(loc, "validation.required", "required")
		return s, &f
	case len([]rune(s)) > maxLen:
		f := tooLong(loc, maxLen)
		return s, &f
	case strings.ContainsFunc(s, unicode.IsControl):
		f := apperr.Field(loc, "validation.control_chars", "control characters are not allowed")
		return s, &f
	}
	return s, nil
}

// multiLine trims s, normalises line breaks to \n and checks its length and
// that it has no control characters but line breaks and tabs.
func multiLine(loc, s string, maxLen int) (string, *apperr.FieldError) {
	s = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n"))
	if len([]rune(s)) > maxLen {
		f := tooLong(loc, maxLen)
		return s, &f
	}
	if strings.ContainsFunc(s, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\t' }) {
		f := apperr.Field(loc, "validation.control_chars", "control characters are not allowed")
		return s, &f
	}
	return s, nil
}

func tooLong(loc string, maxLen int) apperr.FieldError {
	return apperr.Field(loc, "validation.too_long", fmt.Sprintf("longer than %d characters", maxLen)).With("max", maxLen)
}

func validEmail(s string) bool {
	a, err := mail.ParseAddress(s)
	return err == nil && a.Name == "" && a.Address == s
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// trimRate drops the trailing zeros of a stored rate: "0.920000" → "0.92".
func trimRate(r string) string {
	if strings.Contains(r, ".") {
		r = strings.TrimRight(strings.TrimRight(r, "0"), ".")
	}
	return r
}

func projectActions(actor auth.Actor, status ProjectStatus) ProjectActions {
	write := actor.Can(auth.PermProjectsWrite)
	return ProjectActions{
		Update: write && status == StatusActive,
		Delete: actor.Can(auth.PermProjectsDelete),
		Reopen: write && status != StatusActive,
	}
}

func versionOf(v store.ProjectVersion, can ProjectActions, count int) ProjectVersion {
	return ProjectVersion{
		ID: v.ID, ProjectID: v.ProjectID, Name: v.Name, Notes: v.Notes, Position: v.Position,
		CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt,
		Can: ProjectVersionActions{Update: can.Update, Delete: can.Update && count > 1},
	}
}

// nextVersionName is V<n> for the version count + 1, or the next n whose
// name is free.
func nextVersionName(versions []store.ProjectVersion) string {
	taken := map[string]bool{}
	for _, v := range versions {
		taken[strings.ToLower(v.Name)] = true
	}
	for n := len(versions) + 1; ; n++ {
		if name := fmt.Sprintf("V%d", n); !taken[strings.ToLower(name)] {
			return name
		}
	}
}

// listStatus maps the status filter to the query's: "" (default) is
// active, "all" every status.
func listStatus(s string) (string, error) {
	switch s {
	case "":
		return string(StatusActive), nil
	case "all":
		return "", nil
	case string(StatusActive), string(StatusCompleted), string(StatusCancelled):
		return s, nil
	}
	return "", apperr.Invalid("query.status", "validation.invalid", "unknown status")
}

func likePattern(search string) string {
	search = strings.TrimSpace(search)
	if search == "" {
		return ""
	}
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(search) + "%"
}

func checkPage(limit, offset int) error {
	var errs []apperr.FieldError
	if limit < 1 || limit > MaxPageSize {
		errs = append(errs, apperr.Field("query.limit", "validation.invalid", "limit must be 1-200"))
	}
	if offset < 0 || offset > 1<<30 {
		errs = append(errs, apperr.Field("query.offset", "validation.invalid", "offset must not be negative"))
	}
	if len(errs) > 0 {
		return apperr.Validation(errs...)
	}
	return nil
}

func sameSet(a, b []uuid.UUID) bool {
	if len(a) != len(b) {
		return false
	}
	for _, id := range a {
		if !slices.Contains(b, id) {
			return false
		}
	}
	return true
}

// typeOrder is the catalog order of the product types.
type typeOrder map[uuid.UUID]int

func (s *Service) typeOrder(ctx context.Context) (typeOrder, error) {
	all, err := s.types.List(ctx, true)
	if err != nil {
		return nil, err
	}
	o := make(typeOrder, len(all))
	for i, t := range all {
		o[t.ID] = i
	}
	return o, nil
}

func (o typeOrder) sort(ids []uuid.UUID) []uuid.UUID {
	out := slices.Clone(ids)
	if out == nil {
		out = []uuid.UUID{}
	}
	slices.SortFunc(out, func(a, b uuid.UUID) int { return o[a] - o[b] })
	return out
}

// tenantRefs names the tenants of ids in one lookup, for callers who see
// every tenant; others get no tenant references (an empty map).
func (s *Service) tenantRefs(ctx context.Context, actor auth.Actor, ids []uuid.UUID) (map[uuid.UUID]*ProjectTenant, error) {
	out := map[uuid.UUID]*ProjectTenant{}
	if !actor.Can(auth.PermTenantsAccessAll) || len(ids) == 0 {
		return out, nil
	}
	slices.SortFunc(ids, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	found, err := s.tenants.LookupMany(ctx, slices.Compact(ids))
	if err != nil {
		return nil, err
	}
	for id, t := range found {
		out[id] = &ProjectTenant{ID: t.ID, Name: t.Name, Archived: t.ArchivedAt != nil}
	}
	return out, nil
}

func errNotFound() *apperr.Error { return apperr.NotFound("project.not_found") }

func errStale() *apperr.Error {
	return apperr.Conflict("project.stale", "the project was changed by someone else")
}

func errReadOnly() *apperr.Error {
	return apperr.Conflict("project.read_only", "the project is completed or cancelled; reopen it first")
}

// mapRefErr maps a foreign-key violation by a product type or tenant deleted
// between validation and the write to the validation error the check before
// would have given.
func mapRefErr(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23503" {
		return err
	}
	switch pgErr.ConstraintName {
	case "project_product_types_product_type_id_fkey":
		return apperr.Invalid("body.productTypeIds", "project.product_type_not_found", "a product type was deleted meanwhile")
	case "projects_tenant_id_fkey", "project_number_counters_tenant_id_fkey":
		return apperr.Invalid("body.tenantId", "project.tenant_not_found", "the tenant was deleted meanwhile")
	}
	return err
}

func mapVersionErr(err error, name string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("project_version.not_found")
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return apperr.Conflict("project_version.name_taken", "the project already has a version of this name").With("name", name)
	}
	return err
}
