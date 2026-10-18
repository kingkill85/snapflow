// Package imports is the catalog import (D119): a file (XLSX or CSV, read by
// platform/importsrc) is mapped by a saved profile to products, variants,
// add-ons and images; a preview computes the diff against the catalog with
// row errors and warnings; apply writes exactly that diff in one
// transaction through the products, categories and files services; an
// applied run can be undone while nothing it touched changed since.
// Everything needs catalog.write.
package imports

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/features/categories"
	"github.com/kingkill85/snapflow/backend/internal/features/files"
	"github.com/kingkill85/snapflow/backend/internal/features/imports/store"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/features/users"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/importsrc"
)

// Limits of an import (D124, D148).
const (
	MaxFileSize = 50 << 20
	// MaxRows is the most data rows (from the first data row on).
	MaxRows = 20_000
	// MaxLeadingRows is how many rows with content a file may have above
	// MaxRows in all (title, header and other rows above the data); the file
	// is read before a mapping says where the data starts.
	MaxLeadingRows = 1_000
	// MaxColumns is the most columns a row may use.
	MaxColumns = 1_000
	MaxImages  = 5_000
	// MaxImageBytes is how many bytes the distinct pictures of a sheet may
	// have together.
	MaxImageBytes = 256 << 20
	MaxPageSize   = 500
	maxNameLength = 255
	// sourceRows is how many data rows the source preview shows by default.
	sourceRows = 5
)

// DB is the database the service runs on; *pgxpool.Pool implements it.
type DB interface {
	store.DBTX
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

type Service struct {
	db       DB
	q        *store.Queries
	types    *producttypes.Service
	cats     *categories.Service
	products *products.Service
	files    *files.Service
	users    *users.Service
}

func NewService(db DB, types *producttypes.Service, cats *categories.Service, products *products.Service, files *files.Service, users *users.Service) *Service {
	return &Service{db: db, q: store.New(db), types: types, cats: cats, products: products, files: files, users: users}
}

func (s *Service) inTx(ctx context.Context, opts pgx.TxOptions, fn func(tx pgx.Tx, q *store.Queries) error) error {
	return database.InTx(ctx, s.db, opts, func(tx pgx.Tx) error { return fn(tx, s.q.WithTx(tx)) })
}

// ---------------------------------------------------------------- profiles

// Profiles lists the saved profiles by name. When there are none, the
// starter profile for SnapFlow 1 workbooks is created first (D121).
func (s *Service) Profiles(ctx context.Context) ([]ImportProfile, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return nil, err
	}
	n, err := s.q.CountProfiles(ctx)
	if err != nil {
		return nil, err
	}
	if n == 0 {
		mapping, err := json.Marshal(StarterMapping())
		if err != nil {
			return nil, err
		}
		if err := s.q.CreateProfileIfMissing(ctx, store.CreateProfileIfMissingParams{Name: StarterProfileName, Mapping: mapping}); err != nil {
			return nil, err
		}
	}
	rows, err := s.q.ListProfiles(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]ImportProfile, 0, len(rows))
	for _, r := range rows {
		p, err := profileOut(actor, r)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

func (s *Service) Profile(ctx context.Context, id uuid.UUID) (ImportProfile, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return ImportProfile{}, err
	}
	row, err := s.q.GetProfile(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ImportProfile{}, apperr.NotFound("import_profile.not_found")
	}
	if err != nil {
		return ImportProfile{}, err
	}
	return profileOut(actor, row)
}

func (s *Service) CreateProfile(ctx context.Context, in ImportProfileInput) (ImportProfile, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return ImportProfile{}, err
	}
	in, mapping, err := s.validateProfile(ctx, in)
	if err != nil {
		return ImportProfile{}, err
	}
	row, err := s.q.CreateProfile(ctx, store.CreateProfileParams{Name: in.Name, Mapping: mapping})
	if err != nil {
		return ImportProfile{}, mapProfileErr(err, in.Name)
	}
	return profileOut(actor, row)
}

// UpdateProfile replaces a profile; import_profile.stale if it changed
// since in.ExpectedUpdatedAt (D37).
func (s *Service) UpdateProfile(ctx context.Context, id uuid.UUID, in ImportProfileUpdate) (ImportProfile, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return ImportProfile{}, err
	}
	input, mapping, err := s.validateProfile(ctx, in.ImportProfileInput)
	if err != nil {
		return ImportProfile{}, err
	}
	row, err := s.q.UpdateProfile(ctx, store.UpdateProfileParams{ID: id, Name: input.Name, Mapping: mapping, ExpectedUpdatedAt: in.ExpectedUpdatedAt})
	if errors.Is(err, pgx.ErrNoRows) {
		exists, err := s.q.ProfileExists(ctx, id)
		if err != nil {
			return ImportProfile{}, err
		}
		if exists {
			return ImportProfile{}, apperr.Conflict("import_profile.stale", "the profile was changed by someone else")
		}
		return ImportProfile{}, apperr.NotFound("import_profile.not_found")
	}
	if err != nil {
		return ImportProfile{}, mapProfileErr(err, input.Name)
	}
	return profileOut(actor, row)
}

// DeleteProfile removes a profile; runs keep their copy of its mapping.
func (s *Service) DeleteProfile(ctx context.Context, id uuid.UUID) error {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return err
	}
	n, err := s.q.DeleteProfile(ctx, id)
	if err != nil {
		return err
	}
	if n == 0 {
		return apperr.NotFound("import_profile.not_found")
	}
	return nil
}

func (s *Service) validateProfile(ctx context.Context, in ImportProfileInput) (ImportProfileInput, []byte, error) {
	types, cats, err := s.refs(ctx)
	if err != nil {
		return in, nil, err
	}
	errs := []apperr.FieldError{}
	in.Name = strings.TrimSpace(in.Name)
	switch {
	case in.Name == "":
		errs = append(errs, apperr.Field("body.name", "validation.required", "name is required"))
	case utf8.RuneCountInString(in.Name) > MaxProfileNameLength:
		errs = append(errs, apperr.Field("body.name", "validation.too_long", "name too long").With("max", MaxProfileNameLength))
	}
	var mappingErrs []apperr.FieldError
	in.Mapping, mappingErrs = validateMapping(in.Mapping, typesByID(types), categoriesByID(cats), "body.mapping")
	errs = append(errs, mappingErrs...)
	if len(errs) > 0 {
		return in, nil, apperr.Validation(errs...)
	}
	mapping, err := json.Marshal(in.Mapping)
	return in, mapping, err
}

func mapProfileErr(err error, name string) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return apperr.Conflict("import_profile.name_taken", "a profile with this name exists").With("name", name)
	}
	return err
}

func profileOut(actor auth.Actor, r store.ImportProfile) (ImportProfile, error) {
	p := ImportProfile{ID: r.ID, Name: r.Name, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		Can: auth.Actions{Update: actor.Can(auth.PermCatalogWrite), Delete: actor.Can(auth.PermCatalogWrite)}}
	if err := json.Unmarshal(r.Mapping, &p.Mapping); err != nil {
		return p, fmt.Errorf("imports: profile %s mapping: %w", r.ID, err)
	}
	if p.Mapping.Fields == nil {
		p.Mapping.Fields = []ImportField{}
	}
	return p, nil
}

// Targets lists what columns can be mapped to; the attribute targets of the
// given categories (all categories when none are given).
func (s *Service) Targets(ctx context.Context, categoryIDs []uuid.UUID) ([]ImportTarget, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return nil, err
	}
	cats, err := s.cats.List(ctx, true)
	if err != nil {
		return nil, err
	}
	only := map[uuid.UUID]bool{}
	for _, id := range categoryIDs {
		only[id] = true
	}
	return targets(cats, only), nil
}

// refs reads every product type and category, active or not.
func (s *Service) refs(ctx context.Context) ([]producttypes.ProductType, []categories.Category, error) {
	types, err := s.types.List(ctx, true)
	if err != nil {
		return nil, nil, err
	}
	cats, err := s.cats.List(ctx, true)
	if err != nil {
		return nil, nil, err
	}
	return types, cats, nil
}

func typesByID(list []producttypes.ProductType) map[uuid.UUID]producttypes.ProductType {
	out := make(map[uuid.UUID]producttypes.ProductType, len(list))
	for _, t := range list {
		out[t.ID] = t
	}
	return out
}

func categoriesByID(list []categories.Category) map[uuid.UUID]categories.Category {
	out := make(map[uuid.UUID]categories.Category, len(list))
	for _, c := range list {
		out[c.ID] = c
	}
	return out
}

// ---------------------------------------------------------------- runs

// ErrTooLarge reports an upload above MaxFileSize.
func ErrTooLarge() *apperr.Error {
	return apperr.New(http.StatusRequestEntityTooLarge, "import.too_large", "the file is too large").With("maxMb", MaxFileSize>>20)
}

func limits() importsrc.Limits {
	return importsrc.Limits{MaxRows: MaxRows + MaxLeadingRows, MaxColumns: MaxColumns, MaxImages: MaxImages,
		MaxImageBytes: files.MaxSize, MaxImageTotal: MaxImageBytes}
}

// Upload stores an import file (XLSX or UTF-8 CSV by extension and
// content, at most MaxFileSize) as a new run (state uploaded). The client
// previews it with a profile or mapping next (D136).
func (s *Service) Upload(ctx context.Context, name string, data []byte) (ImportRun, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return ImportRun{}, err
	}
	if len(data) > MaxFileSize {
		return ImportRun{}, ErrTooLarge()
	}
	name = strings.TrimSpace(path.Base(strings.ReplaceAll(name, `\`, "/")))
	if name == "." || name == "/" {
		name = ""
	}
	name = truncate(name, maxNameLength)
	src, err := importsrc.Open(name, data, limits(), importsrc.Options{})
	if err != nil {
		return ImportRun{}, err
	}
	defer func() { _ = src.Close() }()
	if len(src.Sheets()) == 0 {
		return ImportRun{}, importsrc.ErrUnreadable()
	}
	// Read the first sheet now, so a file over the limits is refused at
	// once rather than at its first preview.
	if _, err := src.Table(""); err != nil {
		return ImportRun{}, err
	}
	user, err := s.users.Me(ctx)
	if err != nil {
		return ImportRun{}, err
	}
	userName := user.FullName
	if userName == "" {
		userName = user.Email
	}
	contentType := "text/csv"
	if src.Kind() == importsrc.KindXLSX {
		contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	}
	file, err := s.files.StoreDocument(ctx, files.Catalog, data, contentType)
	if err != nil {
		return ImportRun{}, err
	}
	userID := actor.UserID
	row, err := s.q.CreateRun(ctx, store.CreateRunParams{
		FileID: file.ID, FileName: name, FileSize: int64(len(data)), SourceKind: string(src.Kind()),
		UserID: &userID, UserName: userName,
	})
	if err != nil {
		return ImportRun{}, err
	}
	return runOut(row)
}

// DeleteRun removes a run with its diff, issues and change log; the stored
// file is no longer referenced by it (files are kept, D58). An applied run
// must be undone first (409 import.state): its change log is what undo
// needs (D150).
func (s *Service) DeleteRun(ctx context.Context, id uuid.UUID) error {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return err
	}
	return s.inTx(ctx, pgx.TxOptions{}, func(_ pgx.Tx, q *store.Queries) error {
		run, err := q.LockRun(ctx, id)
		if err != nil {
			return notFound(err)
		}
		if run.State == StateApplied {
			return errState(run.State)
		}
		_, err = q.DeleteRun(ctx, id)
		return err
	})
}

// ImportRun returns a run.
func (s *Service) Run(ctx context.Context, id uuid.UUID) (ImportRun, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return ImportRun{}, err
	}
	row, err := s.getRun(ctx, s.q, id)
	if err != nil {
		return ImportRun{}, err
	}
	return runOut(row)
}

// Runs lists the runs, newest first.
func (s *Service) Runs(ctx context.Context, limit, offset int) (ImportRunPage, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return ImportRunPage{}, err
	}
	if err := checkPage(limit, offset); err != nil {
		return ImportRunPage{}, err
	}
	var (
		rows  []store.ImportRun
		total int64
	)
	err := database.InTx(ctx, s.db, database.ReadOnlySnapshot, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		var err error
		if rows, err = q.ListRuns(ctx, store.ListRunsParams{RowLimit: int32(limit), RowOffset: int32(offset)}); err != nil { //nolint:gosec // checked
			return err
		}
		total, err = q.CountRuns(ctx)
		return err
	})
	if err != nil {
		return ImportRunPage{}, err
	}
	page := ImportRunPage{Items: make([]ImportRun, 0, len(rows)), Total: total}
	for _, r := range rows {
		run, err := runOut(r)
		if err != nil {
			return ImportRunPage{}, err
		}
		page.Items = append(page.Items, run)
	}
	return page, nil
}

// Source shows a run's file for mapping: its sheets, the columns with the
// header row's texts and the first data rows.
func (s *Service) Source(ctx context.Context, id uuid.UUID, sheet string, headerRow, rows int) (ImportSourcePreview, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return ImportSourcePreview{}, err
	}
	row, err := s.getRun(ctx, s.q, id)
	if err != nil {
		return ImportSourcePreview{}, err
	}
	src, table, err := s.open(ctx, row, sheet, headerRow)
	if err != nil {
		return ImportSourcePreview{}, err
	}
	defer func() { _ = src.Close() }()
	if rows <= 0 {
		rows = sourceRows
	}
	out := ImportSourcePreview{Sheets: src.Sheets(), Sheet: table.Sheet, HeaderRow: headerRow, Columns: []ImportSourceColumn{}, Rows: []ImportSourceRow{}, Images: table.Images}
	width := 0
	var header importsrc.Row
	for _, r := range table.Rows {
		if r.Number == headerRow {
			header = r
		}
		if r.Number >= headerRow {
			width = max(width, len(r.Cells))
		}
	}
	for col := range width {
		out.Columns = append(out.Columns, ImportSourceColumn{Letter: importsrc.ColumnName(col), Header: header.Cell(col)})
	}
	for _, r := range table.Rows {
		if r.Number <= headerRow || textBlank(r) {
			continue
		}
		out.DataRows++
		if len(out.Rows) < rows {
			cells := make([]string, width)
			for col := range width {
				cells[col] = r.Cell(col)
			}
			out.Rows = append(out.Rows, ImportSourceRow{Number: r.Number, Cells: cells, Images: len(r.Images)})
		}
	}
	return out, nil
}

// ImportPreviewInput chooses the mapping of a preview: a saved profile or an
// unsaved mapping.
type ImportPreviewInput struct {
	ProfileID *uuid.UUID     `json:"profileId,omitempty" doc:"A saved profile; or send mapping"`
	Mapping   *ImportMapping `json:"mapping,omitempty" doc:"An unsaved mapping; or send profileId"`
}

// Preview computes the diff of a run's file against the catalog with the
// profile's (or the given) mapping, stores it with the row issues and the
// catalog snapshot token, and returns the run (state previewed). Pictures
// are stored as files already (content-addressed, so nothing is
// duplicated; unreferenced ones are kept, D58). A run can be previewed
// again until it is applied.
func (s *Service) Preview(ctx context.Context, id uuid.UUID, in ImportPreviewInput) (ImportRun, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return ImportRun{}, err
	}
	row, err := s.getRun(ctx, s.q, id)
	if err != nil {
		return ImportRun{}, err
	}
	if row.State != StateUploaded && row.State != StatePreviewed && row.State != StateFailed {
		return ImportRun{}, errState(row.State)
	}
	// Product types, categories and the catalog from one snapshot.
	var (
		types   []producttypes.ProductType
		cats    []categories.Category
		catalog []products.CatalogProduct
	)
	err = database.InTx(ctx, s.db, database.ReadOnlySnapshot, func(tx pgx.Tx) error {
		var err error
		if types, err = s.types.WithTx(tx).List(ctx, true); err != nil {
			return err
		}
		if cats, err = s.cats.WithTx(tx).List(ctx, true); err != nil {
			return err
		}
		catalog, err = s.products.WithTx(tx).Catalog(ctx)
		return err
	})
	if err != nil {
		return ImportRun{}, err
	}
	var (
		mapping     ImportMapping
		profileName *string
		loc         = "body.mapping"
	)
	switch {
	case (in.ProfileID == nil) == (in.Mapping == nil):
		return ImportRun{}, apperr.Validation(apperr.Field("body", "import.mapping_required", "send profileId or mapping"))
	case in.ProfileID != nil:
		p, err := s.Profile(ctx, *in.ProfileID)
		if err != nil {
			return ImportRun{}, err
		}
		mapping, profileName, loc = p.Mapping, &p.Name, "mapping"
	default:
		mapping = *in.Mapping
	}
	mapping, errs := validateMapping(mapping, typesByID(types), categoriesByID(cats), loc)
	if len(errs) > 0 {
		return ImportRun{}, apperr.Validation(errs...)
	}
	src, table, err := s.open(ctx, row, mapping.Sheet, mapping.HeaderRow)
	if err != nil {
		return ImportRun{}, err
	}
	defer func() { _ = src.Close() }()
	// Pictures stored by an earlier preview of the run are not read again
	// (the same part name in the same file is the same picture).
	known := map[string]uuid.UUID{}
	if len(row.Images) > 0 {
		if err := json.Unmarshal(row.Images, &known); err != nil {
			return ImportRun{}, err
		}
	}
	pl, err := buildPlan(planInput{
		mapping: mapping, table: table, types: types, categories: cats, catalog: catalog,
		storeImage: func(img importsrc.Image) (uuid.UUID, error) {
			if id, ok := known[img.Name]; ok {
				return id, nil
			}
			data, err := src.ImageData(img.Name)
			if err != nil {
				return uuid.Nil, err
			}
			f, err := s.files.UploadBytes(ctx, files.Catalog, data)
			return f.ID, err
		},
	}, loc)
	if err != nil {
		return ImportRun{}, err
	}
	for name, id := range known {
		if _, ok := pl.images[name]; !ok {
			pl.images[name] = id
		}
	}
	token, err := scopeToken(types, cats, catalog, pl.scope)
	if err != nil {
		return ImportRun{}, err
	}
	scopeJSON, err := json.Marshal(pl.scope)
	if err != nil {
		return ImportRun{}, err
	}
	imagesJSON, err := json.Marshal(pl.images)
	if err != nil {
		return ImportRun{}, err
	}
	mappingJSON, err := json.Marshal(mapping)
	if err != nil {
		return ImportRun{}, err
	}
	counts, err := json.Marshal(runCounts{Preview: &pl.counts})
	if err != nil {
		return ImportRun{}, err
	}
	items, err := itemRows(id, pl.entries)
	if err != nil {
		return ImportRun{}, err
	}
	issues, err := issueRows(id, pl.issues, 0)
	if err != nil {
		return ImportRun{}, err
	}
	err = s.inTx(ctx, pgx.TxOptions{}, func(_ pgx.Tx, q *store.Queries) error {
		locked, err := q.LockRun(ctx, id)
		if err != nil {
			return notFound(err)
		}
		if locked.State != StateUploaded && locked.State != StatePreviewed && locked.State != StateFailed {
			return errState(locked.State)
		}
		if err := q.DeleteItems(ctx, id); err != nil {
			return err
		}
		if err := q.DeleteIssues(ctx, id); err != nil {
			return err
		}
		if _, err := q.InsertItems(ctx, items); err != nil {
			return err
		}
		if _, err := q.InsertIssues(ctx, issues); err != nil {
			return err
		}
		row, err = q.SetRunPreview(ctx, store.SetRunPreviewParams{
			ID: id, ProfileID: in.ProfileID, ProfileName: profileName, Mapping: mappingJSON,
			AllOrNothing: mapping.AllOrNothing, CatalogToken: token, CatalogScope: scopeJSON, Counts: counts, Images: imagesJSON,
		})
		return err
	})
	if err != nil {
		return ImportRun{}, err
	}
	return runOut(row)
}

// open reads the sheet of a run's file; the caller closes the source.
func (s *Service) open(ctx context.Context, row store.ImportRun, sheet string, headerRow int) (importsrc.Source, *importsrc.Table, error) {
	_, data, err := s.files.ReadAll(ctx, row.FileID, MaxFileSize)
	if err != nil {
		return nil, nil, err
	}
	src, err := importsrc.Open(row.FileName, data, limits(), importsrc.Options{HeaderRow: headerRow})
	if err != nil {
		return nil, nil, err
	}
	table, err := src.Table(sheet)
	if err != nil {
		_ = src.Close()
		return nil, nil, err
	}
	return src, table, nil
}

// ImportItemFilter narrows the diff list.
type ImportItemFilter struct {
	Entity      string
	Status      string
	OnlySkipped bool
	// ChangedOnly leaves out unchanged items.
	ChangedOnly bool
	// Row keeps the items of this file row (0: any).
	Row int
	// Search matches model number, SKU, category key and names (substring,
	// ignoring case) or, if it is a number, a file row.
	Search string
	Limit  int
	Offset int
}

// Items pages a run's previewed diff in plan order.
func (s *Service) Items(ctx context.Context, id uuid.UUID, f ImportItemFilter) (ImportItemPage, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return ImportItemPage{}, err
	}
	if err := checkPage(f.Limit, f.Offset); err != nil {
		return ImportItemPage{}, err
	}
	if _, err := s.getRun(ctx, s.q, id); err != nil {
		return ImportItemPage{}, err
	}
	var fileRow, searchRow *int32
	if f.Row > 0 {
		r := int32(min(f.Row, maxRowNumber)) //nolint:gosec // bounded
		fileRow = &r
	}
	search := strings.TrimSpace(f.Search)
	if n, err := strconv.Atoi(search); err == nil && n > 0 && n <= maxRowNumber {
		r := int32(n) //nolint:gosec // bounded
		searchRow = &r
	}
	pattern := likePattern(search)
	var (
		rows  []store.ListItemsRow
		total int64
	)
	err := database.InTx(ctx, s.db, database.ReadOnlySnapshot, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		var err error
		rows, err = q.ListItems(ctx, store.ListItemsParams{RunID: id, Entity: f.Entity, Status: f.Status, OnlySkipped: f.OnlySkipped,
			ChangedOnly: f.ChangedOnly, FileRow: fileRow, Search: pattern, SearchRow: searchRow,
			RowLimit: int32(f.Limit), RowOffset: int32(f.Offset)}) //nolint:gosec // checked
		if err != nil {
			return err
		}
		total, err = q.CountItems(ctx, store.CountItemsParams{RunID: id, Entity: f.Entity, Status: f.Status, OnlySkipped: f.OnlySkipped,
			ChangedOnly: f.ChangedOnly, FileRow: fileRow, Search: pattern, SearchRow: searchRow})
		return err
	})
	if err != nil {
		return ImportItemPage{}, err
	}
	page := ImportItemPage{Items: make([]ImportItem, len(rows)), Total: total}
	for i, r := range rows {
		if err := json.Unmarshal(r.Item, &page.Items[i]); err != nil {
			return ImportItemPage{}, err
		}
	}
	return page, nil
}

// Issues pages a run's row errors and warnings in row order.
func (s *Service) Issues(ctx context.Context, id uuid.UUID, severity string, limit, offset int) (ImportIssuePage, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return ImportIssuePage{}, err
	}
	if err := checkPage(limit, offset); err != nil {
		return ImportIssuePage{}, err
	}
	if _, err := s.getRun(ctx, s.q, id); err != nil {
		return ImportIssuePage{}, err
	}
	rows, err := s.q.ListIssues(ctx, store.ListIssuesParams{RunID: id, Severity: severity, RowLimit: int32(limit), RowOffset: int32(offset)}) //nolint:gosec // checked
	if err != nil {
		return ImportIssuePage{}, err
	}
	total, err := s.q.CountIssues(ctx, store.CountIssuesParams{RunID: id, Severity: severity})
	if err != nil {
		return ImportIssuePage{}, err
	}
	page := ImportIssuePage{Items: make([]ImportIssue, len(rows)), Total: total}
	for i, r := range rows {
		if err := json.Unmarshal(r, &page.Items[i]); err != nil {
			return ImportIssuePage{}, err
		}
	}
	return page, nil
}

// Changes pages an applied run's change log.
func (s *Service) Changes(ctx context.Context, id uuid.UUID, limit, offset int) (ImportChangePage, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return ImportChangePage{}, err
	}
	if err := checkPage(limit, offset); err != nil {
		return ImportChangePage{}, err
	}
	if _, err := s.getRun(ctx, s.q, id); err != nil {
		return ImportChangePage{}, err
	}
	rows, err := s.q.ListChanges(ctx, store.ListChangesParams{RunID: id, RowLimit: int32(limit), RowOffset: int32(offset)}) //nolint:gosec // checked
	if err != nil {
		return ImportChangePage{}, err
	}
	total, err := s.q.CountChanges(ctx, id)
	if err != nil {
		return ImportChangePage{}, err
	}
	page := ImportChangePage{Items: make([]ImportChange, len(rows)), Total: total}
	for i, r := range rows {
		c, err := changeOut(r)
		if err != nil {
			return ImportChangePage{}, err
		}
		page.Items[i] = c
	}
	return page, nil
}

func changeOut(r store.ImportChange) (ImportChange, error) {
	c := ImportChange{Seq: int(r.Seq), Entity: r.Entity, Action: r.Action, EntityID: r.EntityID, Label: r.Label}
	if r.Before != nil {
		if err := json.Unmarshal(r.Before, &c.Before); err != nil {
			return c, err
		}
	}
	err := json.Unmarshal(r.After, &c.After)
	return c, err
}

func (s *Service) getRun(ctx context.Context, q *store.Queries, id uuid.UUID) (store.ImportRun, error) {
	row, err := q.GetRun(ctx, id)
	return row, notFound(err)
}

func notFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("import.not_found")
	}
	return err
}

func errState(state string) error {
	return apperr.Conflict("import.state", "not possible in this state").With("state", state)
}

func checkPage(limit, offset int) error {
	var errs []apperr.FieldError
	if limit < 1 || limit > MaxPageSize {
		errs = append(errs, apperr.Field("query.limit", "validation.invalid", "limit must be 1-500"))
	}
	if offset < 0 || offset > 1<<30 {
		errs = append(errs, apperr.Field("query.offset", "validation.invalid", "offset must not be negative"))
	}
	if len(errs) > 0 {
		return apperr.Validation(errs...)
	}
	return nil
}

// runCounts is the counts column: the preview's and, once applied, what
// the apply wrote.
type runCounts struct {
	Preview *ImportCounts `json:"preview,omitempty"`
	Applied *ImportCounts `json:"applied,omitempty"`
}

func runOut(r store.ImportRun) (ImportRun, error) {
	run := ImportRun{
		ID: r.ID, State: r.State, FileID: r.FileID, FileName: r.FileName, FileSize: r.FileSize, SourceKind: r.SourceKind,
		ProfileID: r.ProfileID, UserName: r.UserName, AllOrNothing: r.AllOrNothing,
		CreatedAt: r.CreatedAt, PreviewedAt: r.PreviewedAt, AppliedAt: r.AppliedAt, UndoneAt: r.UndoneAt,
		Can: ImportRunActions{
			Preview: r.State == StateUploaded || r.State == StatePreviewed || r.State == StateFailed,
			Apply:   r.State == StatePreviewed,
			Undo:    r.State == StateApplied,
			Delete:  r.State != StateApplied,
		},
	}
	if r.ProfileName != nil {
		run.ProfileName = *r.ProfileName
	}
	if r.Mapping != nil {
		run.Mapping = &ImportMapping{}
		if err := json.Unmarshal(r.Mapping, run.Mapping); err != nil {
			return run, err
		}
	}
	var counts runCounts
	if err := json.Unmarshal(r.Counts, &counts); err != nil {
		return run, err
	}
	run.Counts, run.Applied = counts.Preview, counts.Applied
	if r.Error != nil {
		run.Error = &ImportRunError{}
		if err := json.Unmarshal(r.Error, run.Error); err != nil {
			return run, err
		}
	}
	return run, nil
}

func itemRows(runID uuid.UUID, entries []*entry) ([]store.InsertItemsParams, error) {
	out := make([]store.InsertItemsParams, len(entries))
	for i, e := range entries {
		if e.item.Changes == nil {
			e.item.Changes = []ImportFieldChange{}
		}
		if e.item.Rows == nil {
			e.item.Rows = []int{}
		}
		item, err := json.Marshal(e.item)
		if err != nil {
			return nil, err
		}
		plan, err := json.Marshal(e.plan)
		if err != nil {
			return nil, err
		}
		out[i] = store.InsertItemsParams{RunID: runID, Seq: int32(e.item.Seq), Entity: e.item.Entity, Status: e.item.Status, //nolint:gosec // bounded by MaxRows
			Skipped: e.item.Skipped, Item: item, Plan: plan}
	}
	return out, nil
}

func issueRows(runID uuid.UUID, issues []ImportIssue, first int) ([]store.InsertIssuesParams, error) {
	out := make([]store.InsertIssuesParams, len(issues))
	for i, is := range issues {
		data, err := json.Marshal(is)
		if err != nil {
			return nil, err
		}
		out[i] = store.InsertIssuesParams{RunID: runID, Seq: int32(first + i + 1), Severity: is.Severity, Issue: data} //nolint:gosec // bounded
	}
	return out, nil
}

// likePattern turns a search into an ILIKE substring pattern ("" for none),
// with the LIKE wildcards matched literally.
func likePattern(search string) string {
	if search == "" {
		return ""
	}
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(search) + "%"
}
