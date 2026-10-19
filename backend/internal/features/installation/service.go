// Package installation builds what the installer gets after planning (step
// 3e): the installation manual and the channel labels (DOCX through the
// document model, recorded as generated documents), the KNX group
// addresses (ETS CSV) and the commissioning lists (XLSX). Everything comes
// from the planned data through the other features' services (plans,
// wiring, networks, products, capabilities, function types, projects,
// tenants, files; CLAUDE.md rule 3); this feature only owns the generated
// document records.
package installation

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"
	"io"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/files"
	"github.com/kingkill85/snapflow/backend/internal/features/functiontypes"
	"github.com/kingkill85/snapflow/backend/internal/features/installation/store"
	"github.com/kingkill85/snapflow/backend/internal/features/networks"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/features/proposals"
	"github.com/kingkill85/snapflow/backend/internal/features/tenants"
	"github.com/kingkill85/snapflow/backend/internal/features/users"
	"github.com/kingkill85/snapflow/backend/internal/features/wiring"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/document"
	"github.com/kingkill85/snapflow/backend/internal/platform/generation"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// Document kinds.
const (
	KindManual = "installation_manual"
	KindLabels = "channel_labels"
)

// Limits (as proposals, D268; the generation limiter is shared with them).
const (
	generationTimeout = 2 * time.Minute
	maxLogoPixels     = 800
	maxImageBytes     = 32 << 20
	maxPlanPixels     = 2400
)

// DB is the database the service runs on; *pgxpool.Pool implements it.
type DB interface {
	store.DBTX
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

type Service struct {
	db            DB
	q             *store.Queries
	projects      *projects.Service
	plans         *plans.Service
	wiring        *wiring.Service
	networks      *networks.Service
	products      *products.Service
	capabilities  *capabilities.Service
	functionTypes *functiontypes.Service
	tenants       *tenants.Service
	files         *files.Service
	users         *users.Service
	docx          document.Exporter
	now           func() time.Time
	generating    *generation.Limiter
}

// Deps are the services the feature reads through.
type Deps struct {
	Projects      *projects.Service
	Plans         *plans.Service
	Wiring        *wiring.Service
	Networks      *networks.Service
	Products      *products.Service
	Capabilities  *capabilities.Service
	FunctionTypes *functiontypes.Service
	Tenants       *tenants.Service
	Files         *files.Service
	Users         *users.Service
	// DOCX renders the documents (the exporter registry's "docx").
	DOCX document.Exporter
}

func NewService(db DB, d Deps) *Service {
	s := &Service{db: db, q: store.New(db), projects: d.Projects, plans: d.Plans, wiring: d.Wiring, networks: d.Networks,
		products: d.Products, capabilities: d.Capabilities, functionTypes: d.FunctionTypes, tenants: d.Tenants, files: d.Files,
		users: d.Users, docx: d.DOCX, now: time.Now, generating: generation.New(generation.Default)}
	// A version copy keeps the group addresses (D422).
	if d.Plans != nil {
		d.Plans.OnCopyPlans(s.copyPlans)
	}
	return s
}

// UseLimiter sets the generation limiter (at wiring time; the instance the
// proposals use, D268).
func (s *Service) UseLimiter(l *generation.Limiter) { s.generating = l }

func (s *Service) inScope(ctx context.Context, actor auth.Actor, opts pgx.TxOptions, fn func(tx pgx.Tx, q *store.Queries) error) error {
	return database.InScope(ctx, s.db, actor, opts, func(tx pgx.Tx) error { return fn(tx, s.q.WithTx(tx)) })
}

// ---------------------------------------------------------------- data

// pngImage is a PNG with its pixel size.
type pngImage struct {
	data          []byte
	width, height int
}

// data is everything the exports read of a version.
type data struct {
	ref        projects.VersionRef
	project    projects.Project
	version    projects.ProjectVersion
	lang       tr
	wiring     wiring.Wiring
	checks     wiring.Checks
	networks   networks.Networks
	addresses  networks.Addresses
	plans      []plans.Plan
	boards     map[uuid.UUID]plans.BoardContent
	variants   map[uuid.UUID]products.BOMVariant
	functions  map[uuid.UUID]functiontypes.FunctionType
	kinds      map[uuid.UUID]capabilities.OutputKind
	loadTypes  map[uuid.UUID]capabilities.LoadType
	itemByKey  map[[2]uuid.UUID]*itemRef
	needByKey  map[[2]uuid.UUID]*wiring.NeedInfo
	addrByKey  map[[2]uuid.UUID]networks.AddressedItem
	lineByID   map[uuid.UUID]networks.BusLine
	prefixByID map[uuid.UUID]networks.LinePrefix
}

// itemRef is a board module or floorplan placement with its document name.
type itemRef struct {
	planID, itemID uuid.UUID
	planName       string
	board          bool
	// position is "D<n>" on a board (module order), else empty.
	position  string
	label     string
	variantID *uuid.UUID
	zoneID    *uuid.UUID
	existing  bool
	widthTE   float64
	rowIndex  int
	offsetTE  float64
}

// load reads a version through the other features' services, each in its
// own read (no transaction held across them, D243).
func (s *Service) load(ctx context.Context, actor auth.Actor, versionID uuid.UUID) (*data, error) {
	d := &data{boards: map[uuid.UUID]plans.BoardContent{}}
	err := s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, _ *store.Queries) error {
		var err error
		d.ref, err = s.projects.ReadVersion(ctx, tx, versionID)
		return err
	})
	if err != nil {
		return nil, err
	}
	if d.project, err = s.projects.Get(ctx, d.ref.ProjectID); err != nil {
		return nil, err
	}
	for _, v := range d.project.Versions {
		if v.ID == versionID {
			d.version = v
		}
	}
	d.lang = tr(d.project.Language)
	if d.plans, err = s.plans.List(ctx, versionID); err != nil {
		return nil, err
	}
	for _, p := range d.plans {
		if p.Kind == plans.KindBoard {
			if d.boards[p.ID], err = s.plans.BoardContent(ctx, p.ID); err != nil {
				return nil, err
			}
		}
	}
	if d.wiring, err = s.wiring.Wiring(ctx, versionID); err != nil {
		return nil, err
	}
	if d.checks, err = s.wiring.Checks(ctx, versionID); err != nil {
		return nil, err
	}
	if d.networks, err = s.networks.Get(ctx, versionID); err != nil {
		return nil, err
	}
	if d.addresses, err = s.networks.GetAddresses(ctx, versionID); err != nil {
		return nil, err
	}
	fts, err := s.functionTypes.List(ctx)
	if err != nil {
		return nil, err
	}
	d.functions = map[uuid.UUID]functiontypes.FunctionType{}
	for _, f := range fts {
		d.functions[f.ID] = f
	}
	kinds, err := s.capabilities.OutputKinds(ctx, true)
	if err != nil {
		return nil, err
	}
	d.kinds = map[uuid.UUID]capabilities.OutputKind{}
	for _, k := range kinds {
		d.kinds[k.ID] = k
	}
	lts, err := s.capabilities.LoadTypes(ctx, true)
	if err != nil {
		return nil, err
	}
	d.loadTypes = map[uuid.UUID]capabilities.LoadType{}
	for _, l := range lts {
		d.loadTypes[l.ID] = l
	}
	return d, s.index(ctx, d)
}

// index builds the lookups: items (board modules numbered D1.. in row and
// offset order), needs, addresses, lines; and reads the variants.
func (s *Service) index(ctx context.Context, d *data) error {
	d.itemByKey = map[[2]uuid.UUID]*itemRef{}
	var ids []uuid.UUID
	for _, p := range d.plans {
		if p.Kind != plans.KindBoard {
			continue
		}
		b := d.boards[p.ID]
		rowIdx := map[uuid.UUID]int{}
		for i, r := range b.Rows {
			rowIdx[r.ID] = i
		}
		mods := slices.Clone(b.Modules)
		slices.SortStableFunc(mods, func(a, c plans.BoardModule) int {
			if ra, rc := rowIdx[a.RowID], rowIdx[c.RowID]; ra != rc {
				return ra - rc
			}
			switch {
			case a.OffsetTE < c.OffsetTE:
				return -1
			case a.OffsetTE > c.OffsetTE:
				return 1
			}
			return 0
		})
		for i, m := range mods {
			d.itemByKey[[2]uuid.UUID{p.ID, m.ID}] = &itemRef{planID: p.ID, itemID: m.ID, planName: p.Name, board: true,
				position: "D" + strconv.Itoa(i+1), label: m.Label, variantID: m.VariantID, existing: m.Existing, widthTE: m.WidthTE,
				rowIndex: rowIdx[m.RowID], offsetTE: m.OffsetTE}
			if m.VariantID != nil {
				ids = append(ids, *m.VariantID)
			}
		}
		if b.EnclosureVariantID != nil {
			ids = append(ids, *b.EnclosureVariantID)
		}
	}
	// Floorplan devices: from the addresses (bus and wireless) and the
	// wiring view (devices with channels); the manual adds the rest from the
	// plan content.
	for _, a := range d.addresses.Items {
		k := [2]uuid.UUID{a.PlanID, a.ItemID}
		if _, ok := d.itemByKey[k]; !ok {
			vid := a.VariantID
			d.itemByKey[k] = &itemRef{planID: a.PlanID, itemID: a.ItemID, planName: a.PlanName, label: a.Label, variantID: &vid, existing: a.Existing,
				zoneID: a.ZoneID}
			ids = append(ids, a.VariantID)
		}
	}
	for _, it := range d.wiring.Items {
		k := [2]uuid.UUID{it.PlanID, it.ItemID}
		if r, ok := d.itemByKey[k]; ok {
			r.zoneID = it.ZoneID
			continue
		}
		d.itemByKey[k] = &itemRef{planID: it.PlanID, itemID: it.ItemID, planName: it.PlanName, label: it.Label, zoneID: it.ZoneID}
	}
	d.needByKey = map[[2]uuid.UUID]*wiring.NeedInfo{}
	for i := range d.wiring.Needs {
		n := &d.wiring.Needs[i]
		d.needByKey[[2]uuid.UUID{n.PlanID, n.NeedID}] = n
	}
	d.addrByKey = map[[2]uuid.UUID]networks.AddressedItem{}
	for _, a := range d.addresses.Items {
		d.addrByKey[[2]uuid.UUID{a.PlanID, a.ItemID}] = a
	}
	d.lineByID = map[uuid.UUID]networks.BusLine{}
	for _, sys := range d.networks.BusSystems {
		for _, l := range sys.Lines {
			d.lineByID[l.ID] = l.BusLine
		}
	}
	d.prefixByID = map[uuid.UUID]networks.LinePrefix{}
	for _, p := range d.addresses.Lines {
		d.prefixByID[p.BusLineID] = p
	}
	slices.SortFunc(ids, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	var err error
	d.variants, err = s.products.BOMVariants(ctx, slices.Compact(ids))
	return err
}

// addVariants reads further variants (floorplan devices of the manual).
func (s *Service) addVariants(ctx context.Context, d *data, ids []uuid.UUID) error {
	var missing []uuid.UUID
	for _, id := range ids {
		if _, ok := d.variants[id]; !ok && !slices.Contains(missing, id) {
			missing = append(missing, id)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	more, err := s.products.BOMVariants(ctx, missing)
	if err != nil {
		return err
	}
	for k, v := range more {
		d.variants[k] = v
	}
	return nil
}

func (s *Service) logo(ctx context.Context, t tenants.Tenant) (*pngImage, error) {
	id := t.Letterhead.LogoFileID
	if id == nil {
		return nil, nil
	}
	img, err := s.files.DecodeReferenced(ctx, *id, maxLogoPixels, maxImageBytes)
	if err != nil || img == nil {
		return nil, err
	}
	p, err := encodePNG(img)
	return &p, err
}

func encodePNG(img image.Image) (pngImage, error) {
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := enc.Encode(&buf, img); err != nil {
		return pngImage{}, err
	}
	b := img.Bounds()
	return pngImage{data: buf.Bytes(), width: b.Dx(), height: b.Dy()}, nil
}

// ---------------------------------------------------------------- documents

// List returns the generated documents of a version, newest first.
func (s *Service) List(ctx context.Context, versionID uuid.UUID) ([]GeneratedDocument, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return nil, err
	}
	var rows []store.GeneratedDocument
	err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.ReadVersion(ctx, tx, versionID); err != nil {
			return err
		}
		rows, err = q.ListDocuments(ctx, versionID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return s.out(ctx, actor, rows)
}

func (s *Service) out(ctx context.Context, actor auth.Actor, rows []store.GeneratedDocument) ([]GeneratedDocument, error) {
	names := map[uuid.UUID]string{}
	out := make([]GeneratedDocument, len(rows))
	for i, r := range rows {
		g := GeneratedDocument{ID: r.ID, VersionID: r.VersionID, Kind: r.Kind, Number: r.Number, Sequence: r.Seq, Exporter: r.Exporter,
			Language: r.Language, FileName: r.FileName, DownloadURL: "/api/documents/" + r.ID.String() + "/file", CreatedBy: r.CreatedBy,
			CreatedAt: r.CreatedAt, Can: DocumentActions{Delete: actor.Can(auth.PermProjectsDelete)}}
		if r.CreatedBy != nil {
			name, ok := names[*r.CreatedBy]
			if !ok {
				var err error
				if name, err = s.users.DisplayName(ctx, *r.CreatedBy); err != nil {
					return nil, err
				}
				names[*r.CreatedBy] = name
			}
			g.CreatedByName = name
		}
		out[i] = g
	}
	return out, nil
}

// File opens a generated document's file.
func (s *Service) File(ctx context.Context, id uuid.UUID) (string, string, int64, io.ReadCloser, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return "", "", 0, nil, err
	}
	var row store.GeneratedDocument
	err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
		var err error
		if row, err = q.GetDocument(ctx, id); err != nil {
			return notFound(err)
		}
		_, err = s.projects.ReadVersion(ctx, tx, row.VersionID)
		return err
	})
	if err != nil {
		return "", "", 0, nil, err
	}
	f, contents, err := s.files.OpenReferenced(ctx, row.FileID)
	if err != nil {
		return "", "", 0, nil, err
	}
	return row.FileName, f.ContentType, f.Size, contents, nil
}

// Delete removes a generated document and then its file unless another row
// references it (D269).
func (s *Service) Delete(ctx context.Context, id uuid.UUID) error {
	actor, err := auth.Require(ctx, auth.PermProjectsDelete)
	if err != nil {
		return err
	}
	var fileID uuid.UUID
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		row, err := q.GetDocument(ctx, id)
		if err != nil {
			return notFound(err)
		}
		if _, err := s.projects.ReadVersion(ctx, tx, row.VersionID); err != nil {
			return err
		}
		fileID = row.FileID
		n, err := q.DeleteDocument(ctx, id)
		if err == nil && n == 0 {
			return errNotFound()
		}
		return err
	})
	if err != nil {
		return err
	}
	s.files.DeleteUnreferencedLogged(ctx, fileID)
	return nil
}

// Generate writes an installation manual or the channel labels of a
// version. Like proposals it is allowed on completed projects (D259: a
// document of the planned state); it needs projects.write.
func (s *Service) Generate(ctx context.Context, versionID uuid.UUID, in DocumentInput) (GeneratedDocument, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return GeneratedDocument{}, err
	}
	if in.Kind != KindManual && in.Kind != KindLabels {
		return GeneratedDocument{}, apperr.Invalid("body.kind", "document.kind_unknown", "unknown document kind").
			With("kinds", KindManual+", "+KindLabels)
	}
	release, err := s.generating.Acquire(ctx)
	if err != nil {
		return GeneratedDocument{}, err
	}
	defer release()
	ctx, cancel := context.WithTimeout(ctx, generationTimeout)
	defer cancel()
	d, err := s.load(ctx, actor, versionID)
	if err != nil {
		return GeneratedDocument{}, err
	}
	tenant, err := s.tenants.Lookup(ctx, d.ref.TenantID)
	if err != nil {
		return GeneratedDocument{}, err
	}
	var seq int32
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		ref, err := s.projects.ReadVersion(ctx, tx, versionID)
		if err != nil {
			return err
		}
		seq, err = q.NextSeq(ctx, store.NextSeqParams{VersionID: versionID, Kind: in.Kind, TenantID: ref.TenantID})
		return err
	})
	if err != nil {
		return GeneratedDocument{}, err
	}
	prefix := "IM"
	if in.Kind == KindLabels {
		prefix = "LB"
	}
	number := d.project.Number + "-" + d.version.Name + "-" + prefix + pad2(seq)
	head := header{number: number, date: s.now(), project: d.project, versionName: d.version.Name, letterhead: tenantLetterhead(tenant)}
	var doc document.Document
	if in.Kind == KindManual {
		if lg, err := s.logo(ctx, tenant); err != nil {
			return GeneratedDocument{}, err
		} else if lg != nil {
			head.letterhead.LogoPNG, head.letterhead.LogoWidth, head.letterhead.LogoHeight = lg.data, lg.width, lg.height
		}
		pages, err := s.floorplans(ctx, d)
		if err != nil {
			return GeneratedDocument{}, err
		}
		doc = manual(d, head, pages)
	} else {
		doc = labels(d, head)
	}
	bytes, err := s.docx.Render(ctx, doc)
	if err != nil {
		return GeneratedDocument{}, err
	}
	f, err := s.files.StoreDocument(ctx, files.TenantScope(d.ref.TenantID), bytes, s.docx.ContentType())
	if err != nil {
		return GeneratedDocument{}, err
	}
	var row store.GeneratedDocument
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		ref, err := s.projects.ReadVersion(ctx, tx, versionID)
		if err != nil {
			return err
		}
		row, err = q.InsertDocument(ctx, store.InsertDocumentParams{
			TenantID: ref.TenantID, VersionID: versionID, Kind: in.Kind, Seq: seq, Number: number, Exporter: s.docx.Key(),
			Language: string(d.lang.norm()), FileID: f.ID, FileName: proposals.FileName(number, d.project.Name, s.docx.FileExtension()),
			CreatedBy: &actor.UserID,
		})
		return err
	})
	if err != nil {
		return GeneratedDocument{}, err
	}
	out, err := s.out(ctx, actor, []store.GeneratedDocument{row})
	if err != nil {
		return GeneratedDocument{}, err
	}
	return out[0], nil
}

func tenantLetterhead(t tenants.Tenant) document.Letterhead {
	lh := t.Letterhead
	company := lh.CompanyName
	if company == "" {
		company = t.Name
	}
	return document.Letterhead{Company: company, Address: lh.Address, Phone: lh.Phone, Email: lh.Email, Website: lh.Website}
}

// ReferencedFiles is the files feature's reference check (D269).
func (s *Service) ReferencedFiles(ctx context.Context, tx pgx.Tx, ids []uuid.UUID) ([]uuid.UUID, error) {
	return store.New(tx).ReferencedFiles(ctx, ids)
}

// DeleteVersionFiles deletes the files of the documents that go with
// deleted versions once nothing else references them (D269).
func (s *Service) DeleteVersionFiles(ctx context.Context, tx pgx.Tx, versionIDs []uuid.UUID) (func(context.Context), error) {
	ids, err := store.New(tx).FilesOfVersions(ctx, versionIDs)
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	return func(ctx context.Context) { s.files.DeleteUnreferencedLogged(ctx, ids...) }, nil
}

func pad2(n int32) string {
	s := strconv.Itoa(int(n))
	if len(s) < 2 {
		s = "0" + s
	}
	return s
}

func notFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound()
	}
	return err
}

func errNotFound() *apperr.Error { return apperr.NotFound("document.not_found") }

// text picks the language's text of an i18n value, else English.
func text(t i18n.Text, lang tr) string {
	if s := strings.TrimSpace(t[string(lang.norm())]); s != "" {
		return s
	}
	return t[i18n.DefaultLocale]
}
