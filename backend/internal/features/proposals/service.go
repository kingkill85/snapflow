// Package proposals generates proposals (step 2d): documents built from one
// version (BOM, totals, zones, plan images, the tenant's letterhead) in the
// project's language, rendered by an exporter (DOCX now), stored as a
// tenant-scoped file and recorded as an immutable proposal.
//
// Data comes through the other features' services (projects, BOM, plans,
// tenants, files; CLAUDE.md rule 3); totals are the BOM service's. No
// transaction is held while a document is rendered: the sequence is reserved
// in a short transaction first, the records are written in another one at
// the end (D243).
package proposals

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	_ "image/jpeg" // plan images and logos
	"image/png"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	_ "golang.org/x/image/webp" // catalog images may be WebP

	"github.com/kingkill85/snapflow/backend/internal/features/bom"
	"github.com/kingkill85/snapflow/backend/internal/features/files"
	"github.com/kingkill85/snapflow/backend/internal/features/plans"
	"github.com/kingkill85/snapflow/backend/internal/features/projects"
	"github.com/kingkill85/snapflow/backend/internal/features/proposals/store"
	"github.com/kingkill85/snapflow/backend/internal/features/tenants"
	"github.com/kingkill85/snapflow/backend/internal/features/users"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/document"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
	"github.com/kingkill85/snapflow/backend/internal/platform/money"
	"github.com/kingkill85/snapflow/backend/internal/platform/planimage"
)

// maxPlanPixels is the long side of a rendered plan image in a document.
const maxPlanPixels = 2400

// maxImageBytes bounds a catalog image or logo read for a document.
const maxImageBytes = 32 << 20

// DB is the database the service runs on; *pgxpool.Pool implements it.
type DB interface {
	store.DBTX
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

type Service struct {
	db        DB
	q         *store.Queries
	projects  *projects.Service
	bom       *bom.Service
	plans     *plans.Service
	tenants   *tenants.Service
	files     *files.Service
	users     *users.Service
	exporters *document.Registry
	now       func() time.Time
}

func NewService(db DB, projectSvc *projects.Service, bomSvc *bom.Service, planSvc *plans.Service, tenantSvc *tenants.Service,
	fileSvc *files.Service, userSvc *users.Service, exporters *document.Registry) *Service {
	return &Service{db: db, q: store.New(db), projects: projectSvc, bom: bomSvc, plans: planSvc, tenants: tenantSvc,
		files: fileSvc, users: userSvc, exporters: exporters, now: time.Now}
}

func (s *Service) inScope(ctx context.Context, actor auth.Actor, opts pgx.TxOptions, fn func(tx pgx.Tx, q *store.Queries) error) error {
	return database.InScope(ctx, s.db, actor, opts, func(tx pgx.Tx) error { return fn(tx, s.q.WithTx(tx)) })
}

// Exporters lists the document formats.
func (s *Service) Exporters(ctx context.Context) ([]ExporterInfo, error) {
	if _, err := auth.Require(ctx, auth.PermProjectsRead); err != nil {
		return nil, err
	}
	out := []ExporterInfo{}
	for _, e := range s.exporters.All() {
		name := i18n.Text{}
		for _, l := range i18n.Locales {
			name[l] = e.Name(l)
		}
		out = append(out, ExporterInfo{Key: e.Key(), Name: name, FileExtension: e.FileExtension(), ContentType: e.ContentType()})
	}
	return out, nil
}

// List returns the proposals of a version, newest first.
func (s *Service) List(ctx context.Context, versionID uuid.UUID) ([]Proposal, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return nil, err
	}
	var rows []store.Proposal
	err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
		if _, err := s.projects.ReadVersion(ctx, tx, versionID); err != nil {
			return err
		}
		rows, err = q.ListProposals(ctx, versionID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return s.out(ctx, actor, rows)
}

func (s *Service) out(ctx context.Context, actor auth.Actor, rows []store.Proposal) ([]Proposal, error) {
	names := map[uuid.UUID]string{}
	out := make([]Proposal, len(rows))
	for i, r := range rows {
		p := Proposal{
			ID: r.ID, VersionID: r.VersionID, Number: r.Number, Sequence: r.Seq, Exporter: r.Exporter, Language: r.Language,
			FileName: r.FileName, DownloadURL: "/api/proposals/" + r.ID.String() + "/file", CreatedBy: r.CreatedBy,
			CreatedAt: r.CreatedAt, Can: ProposalActions{Delete: actor.Can(auth.PermProjectsDelete)},
			Totals: bom.BOMTotals{
				BOMAmounts: bom.BOMAmounts{Subtotal: r.Subtotal, Discount: r.Discount, Services: r.Services, GrandTotal: r.GrandTotal},
				Currency:   r.Currency, Rate: trimRate(r.ExchangeRate),
			},
		}
		if r.ProductTypeID != nil {
			name := i18n.Text{}
			if r.ProductTypeName != nil {
				name = *r.ProductTypeName
			}
			p.ProductType = &NullableProposalProductType{ProposalProductType: ProposalProductType{ID: *r.ProductTypeID, Name: name}}
		}
		if r.ConvertedGrandTotal != nil {
			// Stored with 4 decimals; shown at the currency's minor unit.
			conv := func(s *string) string { return money.Format(money.MustParse(deref(s)), r.Currency) }
			p.Totals.Converted = &bom.NullableBOMAmounts{BOMAmounts: bom.BOMAmounts{
				Subtotal: conv(r.ConvertedSubtotal), Discount: conv(r.ConvertedDiscount),
				Services: conv(r.ConvertedServices), GrandTotal: conv(r.ConvertedGrandTotal),
			}}
		}
		if r.CreatedBy != nil {
			name, ok := names[*r.CreatedBy]
			if !ok {
				var err error
				if name, err = s.users.DisplayName(ctx, *r.CreatedBy); err != nil {
					return nil, err
				}
				names[*r.CreatedBy] = name
			}
			p.CreatedByName = name
		}
		out[i] = p
	}
	return out, nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// trimRate drops trailing zeros of a stored rate ("0.92000000" → "0.92").
func trimRate(s string) string {
	if strings.Contains(s, ".") {
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	return s
}

// File opens a proposal's file.
func (s *Service) File(ctx context.Context, id uuid.UUID) (Proposal, string, int64, io.ReadCloser, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsRead)
	if err != nil {
		return Proposal{}, "", 0, nil, err
	}
	var row store.Proposal
	err = s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, q *store.Queries) error {
		var err error
		if row, err = q.GetProposal(ctx, id); err != nil {
			return notFound(err)
		}
		_, err = s.projects.ReadVersion(ctx, tx, row.VersionID)
		return err
	})
	if err != nil {
		return Proposal{}, "", 0, nil, err
	}
	// The file is in the scope of the tenant the project had when it was
	// generated; the proposal row was checked.
	f, contents, err := s.files.OpenReferenced(ctx, row.FileID)
	if err != nil {
		return Proposal{}, "", 0, nil, err
	}
	return Proposal{ID: row.ID, FileName: row.FileName}, f.ContentType, f.Size, contents, nil
}

// Delete removes a proposal (its file stays, content-addressed).
func (s *Service) Delete(ctx context.Context, id uuid.UUID) error {
	actor, err := auth.Require(ctx, auth.PermProjectsDelete)
	if err != nil {
		return err
	}
	return s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		row, err := q.GetProposal(ctx, id)
		if err != nil {
			return notFound(err)
		}
		if _, err := s.projects.ReadVersion(ctx, tx, row.VersionID); err != nil {
			return err
		}
		n, err := q.DeleteProposal(ctx, id)
		if err == nil && n == 0 {
			return errNotFound()
		}
		return err
	})
}

// ---------------------------------------------------------------- generating

// run is what one generation reads before rendering.
type run struct {
	ref     projects.VersionRef
	project projects.Project
	version projects.ProjectVersion
	tenant  tenants.Tenant
	logo    *pngImage
	bom     bom.BOM
	parts   []document_
}

// document_ is one document of a run: the BOM part and its type.
type document_ struct {
	productType *bom.SnapshotProductType
	bom         bom.BOM
}

// documents splits b as asked (validation errors as fields of the body).
func documents(b bom.BOM, split bool, typeIDs []uuid.UUID) ([]document_, error) {
	if len(b.Lines) == 0 {
		return nil, apperr.New(http.StatusUnprocessableEntity, "proposal.empty", "the version's bill of materials is empty")
	}
	if !split {
		return []document_{{bom: b}}, nil
	}
	if len(typeIDs) == 0 {
		return nil, apperr.Invalid("body.productTypeIds", "proposal.product_types_required", "choose at least one product type")
	}
	slices.SortFunc(typeIDs, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	typeIDs = slices.Compact(typeIDs)
	parts, err := bom.SplitByProductType(b, typeIDs)
	if err != nil {
		return nil, err
	}
	out := make([]document_, len(parts))
	for i, p := range parts {
		pt := p.ProductType
		out[i] = document_{productType: &pt, bom: p.BOM}
	}
	return out, nil
}

// Preview returns the totals the documents of a generation would have.
func (s *Service) Preview(ctx context.Context, versionID uuid.UUID, in PreviewInput) ([]PreviewDocument, error) {
	if _, err := auth.Require(ctx, auth.PermProjectsRead); err != nil {
		return nil, err
	}
	b, err := s.bom.Get(ctx, versionID)
	if err != nil {
		return nil, err
	}
	docs, err := documents(b, in.Split, in.ProductTypeIDs)
	if err != nil {
		return nil, err
	}
	out := make([]PreviewDocument, len(docs))
	for i, d := range docs {
		out[i] = PreviewDocument{Totals: d.bom.Totals}
		if d.productType != nil {
			out[i].ProductType = &NullableProposalProductType{ProposalProductType: ProposalProductType{ID: d.productType.ID, Name: d.productType.Name}}
		}
	}
	return out, nil
}

// Generate writes the proposals of a version.
func (s *Service) Generate(ctx context.Context, versionID uuid.UUID, in GenerateInput) ([]Proposal, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return nil, err
	}
	exp, ok := s.exporters.Get(in.Exporter)
	if !ok {
		return nil, apperr.Invalid("body.exporter", "proposal.exporter_unknown", "unknown exporter").With("exporters", strings.Join(s.exporters.Keys(), ", "))
	}
	r, err := s.read(ctx, actor, versionID, in)
	if err != nil {
		return nil, err
	}
	pages, err := s.planPages(ctx, r)
	if err != nil {
		return nil, err
	}
	// Reserve the sequence (short transaction; a failed run leaves a gap).
	var seq int32
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		ref, err := s.projects.ReadVersion(ctx, tx, versionID)
		if err != nil {
			return err
		}
		seq, err = q.NextSeq(ctx, store.NextSeqParams{VersionID: versionID, TenantID: ref.TenantID})
		return err
	})
	if err != nil {
		return nil, err
	}
	base := r.project.Number + "-" + r.version.Name + "-" + pad2(seq)
	now := s.now()
	lang := tr(r.project.Language)
	var params []store.InsertProposalParams
	for _, d := range r.parts {
		number := base
		var typeID *uuid.UUID
		var typeName *i18n.Text
		if d.productType != nil {
			number += "-" + typeSuffix(*d.productType)
			id, name := d.productType.ID, d.productType.Name
			typeID, typeName = &id, &name
		}
		c := content{
			lang: lang, number: number, date: now, project: r.project, versionName: r.version.Name,
			tenantName: r.tenant.Name, letterhead: r.tenant.Letterhead, logo: r.logo, bom: d.bom, productType: d.productType,
			plans: pages[typeKey(d.productType)],
		}
		data, err := exp.Render(ctx, c.build())
		if err != nil {
			return nil, err
		}
		f, err := s.files.StoreDocument(ctx, files.TenantScope(r.ref.TenantID), data, exp.ContentType())
		if err != nil {
			return nil, err
		}
		t := d.bom.Totals
		p := store.InsertProposalParams{
			TenantID: r.ref.TenantID, VersionID: versionID, Seq: seq, Number: number, Exporter: exp.Key(), Language: string(lang),
			ProductTypeID: typeID, ProductTypeName: typeName, FileID: f.ID,
			FileName: FileName(number, r.project.Name, exp.FileExtension()), Currency: t.Currency, ExchangeRate: t.Rate,
			Subtotal: t.Subtotal, Discount: t.Discount, Services: t.Services, GrandTotal: t.GrandTotal, CreatedBy: &actor.UserID,
		}
		if t.Converted != nil {
			cv := t.Converted
			p.ConvertedSubtotal, p.ConvertedDiscount, p.ConvertedServices, p.ConvertedGrandTotal = &cv.Subtotal, &cv.Discount, &cv.Services, &cv.GrandTotal
		}
		params = append(params, p)
	}
	var rows []store.Proposal
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		ref, err := s.projects.ReadVersion(ctx, tx, versionID)
		if err != nil {
			return err
		}
		for _, p := range params {
			p.TenantID = ref.TenantID // the project may have moved meanwhile
			row, err := q.InsertProposal(ctx, p)
			if err != nil {
				return err
			}
			rows = append(rows, row)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.out(ctx, actor, rows)
}

// read collects everything a run needs, each through its service and
// without a transaction held across them.
func (s *Service) read(ctx context.Context, actor auth.Actor, versionID uuid.UUID, in GenerateInput) (run, error) {
	var r run
	err := s.inScope(ctx, actor, database.ReadOnlySnapshot, func(tx pgx.Tx, _ *store.Queries) error {
		var err error
		r.ref, err = s.projects.ReadVersion(ctx, tx, versionID)
		return err
	})
	if err != nil {
		return r, err
	}
	if r.project, err = s.projects.Get(ctx, r.ref.ProjectID); err != nil {
		return r, err
	}
	for _, v := range r.project.Versions {
		if v.ID == versionID {
			r.version = v
		}
	}
	if r.bom, err = s.bom.Get(ctx, versionID); err != nil {
		return r, err
	}
	if r.parts, err = documents(r.bom, in.Split, in.ProductTypeIDs); err != nil {
		return r, err
	}
	if r.tenant, err = s.tenants.Lookup(ctx, r.ref.TenantID); err != nil {
		return r, err
	}
	if id := r.tenant.Letterhead.LogoFileID; id != nil {
		img, err := s.decodeFile(ctx, *id)
		if err != nil {
			return r, err
		}
		if img != nil {
			p, err := encodePNG(img)
			if err != nil {
				return r, err
			}
			r.logo = &p
		}
	}
	return r, nil
}

// decodeFile reads and decodes an image file; nil when it is gone or not
// an image.
func (s *Service) decodeFile(ctx context.Context, id uuid.UUID) (image.Image, error) {
	_, contents, err := s.files.OpenReferenced(ctx, id)
	var ae *apperr.Error
	if errors.As(err, &ae) && ae.Status == http.StatusNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer func() { _ = contents.Close() }()
	img, _, err := image.Decode(io.LimitReader(contents, maxImageBytes))
	if err != nil {
		return nil, nil //nolint:nilerr // an undecodable image is drawn as a box
	}
	return img, nil
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

// typeKey keys the plan pages of a document: "" for the combined one.
func typeKey(pt *bom.SnapshotProductType) string {
	if pt == nil {
		return ""
	}
	return pt.ID.String()
}

// planPages renders the plan images of every document of a run: the
// combined one shows every placement, a split one only its type's (zones
// always). Plans without zones and placements are left out.
func (s *Service) planPages(ctx context.Context, r run) (map[string][]planPage, error) {
	docPlans, err := s.plans.DocumentPlans(ctx, r.ref.ID)
	if err != nil {
		return nil, err
	}
	snaps, err := s.bom.Snapshots(ctx, r.ref.ID)
	if err != nil {
		return nil, err
	}
	images := map[uuid.UUID]image.Image{}
	for _, p := range docPlans {
		for _, pl := range p.Placements {
			snap, ok := snaps[placementVariant(pl)]
			if !ok || snap.ImageFileID == nil {
				continue
			}
			if _, done := images[*snap.ImageFileID]; done {
				continue
			}
			img, err := s.decodeFile(ctx, *snap.ImageFileID)
			if err != nil {
				return nil, err
			}
			images[*snap.ImageFileID] = img
		}
	}
	lang := tr(r.project.Language)
	out := map[string][]planPage{}
	for _, d := range r.parts {
		key := typeKey(d.productType)
		for _, p := range docPlans {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			page, ok, err := renderPlan(p, snaps, images, d.productType, lang)
			if err != nil {
				return nil, err
			}
			if ok {
				out[key] = append(out[key], page)
			}
		}
	}
	return out, nil
}

func placementVariant(p plans.PlanPlacement) uuid.UUID {
	if p.CatalogVariantID != nil {
		return *p.CatalogVariantID
	}
	if p.VariantID != nil {
		return *p.VariantID
	}
	return uuid.Nil
}

func renderPlan(p plans.DocumentPlan, snaps map[uuid.UUID]bom.VariantSnapshot, images map[uuid.UUID]image.Image,
	only *bom.SnapshotProductType, lang tr) (planPage, bool, error) {
	if len(p.Zones) == 0 && len(p.Placements) == 0 {
		return planPage{}, false, nil
	}
	bg, _, err := image.Decode(bytes.NewReader(p.Image))
	if err != nil {
		return planPage{}, false, nil //nolint:nilerr // a plan whose image cannot be read is left out
	}
	in := planimage.Plan{Background: bg}
	for _, z := range p.Zones {
		in.Zones = append(in.Zones, planimage.Zone{Name: z.Name, Color: hexColor(z.Color), Opacity: z.Opacity, Points: z.Points})
	}
	type typeCount struct {
		name  string
		count int
	}
	var legend []typeCount
	existing := false
	for _, pl := range p.Placements {
		snap, ok := snaps[placementVariant(pl)]
		if only != nil && (!ok || snap.ProductType.ID != only.ID) {
			continue
		}
		item := planimage.Placement{X: pl.X, Y: pl.Y, Width: pl.Width, Height: pl.Height, Rotation: pl.Rotation, Label: pl.Label, Existing: pl.Existing}
		if ok {
			item.Color = hexColor(snap.ProductType.Color)
			if snap.ImageFileID != nil {
				item.Image = images[*snap.ImageFileID]
			}
			name := text(snap.ProductType.Name, lang)
			if i := slices.IndexFunc(legend, func(t typeCount) bool { return t.name == name }); i >= 0 {
				legend[i].count++
			} else {
				legend = append(legend, typeCount{name, 1})
			}
		}
		existing = existing || pl.Existing
		in.Placements = append(in.Placements, item)
	}
	if only != nil && len(in.Placements) == 0 {
		return planPage{}, false, nil
	}
	img, err := encodePNG(planimage.RenderMax(in, maxPlanPixels))
	if err != nil {
		return planPage{}, false, err
	}
	page := planPage{name: p.Name, image: img, existing: existing}
	for _, t := range legend {
		page.legend = append(page.legend, legendEntry{name: t.name, count: t.count})
	}
	return page, true, nil
}

func hexColor(s string) color.RGBA {
	if len(s) != 7 || s[0] != '#' {
		return color.RGBA{0x64, 0x74, 0x8b, 0xff}
	}
	v, err := strconv.ParseUint(s[1:], 16, 32)
	if err != nil {
		return color.RGBA{0x64, 0x74, 0x8b, 0xff}
	}
	return color.RGBA{uint8(v >> 16), uint8(v >> 8), uint8(v), 0xff}
}

func pad2(n int32) string {
	s := strconv.Itoa(int(n))
	if len(s) < 2 {
		s = "0" + s
	}
	return s
}

// typeSuffix names a split document's type in its number: the type's
// abbreviation, else its key, upper case.
func typeSuffix(pt bom.SnapshotProductType) string {
	s := pt.Abbreviation
	if s == "" {
		s = pt.Key
	}
	return strings.ToUpper(sanitize(s))
}

// FileName is "<number> <project name>.<ext>" with characters that are not
// allowed in file names on common systems replaced by "-" and control
// characters removed (as the plan PNG export, D210).
func FileName(number, project, ext string) string {
	name := strings.TrimSpace(sanitize(number + " " + project))
	if r := []rune(name); len(r) > 150 {
		name = strings.TrimSpace(string(r[:150]))
	}
	return name + "." + ext
}

func sanitize(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r < 0x20 || r == 0x7f:
		case strings.ContainsRune(`\/:*?"<>|`, r):
			b.WriteRune('-')
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

func itoa(n int) string     { return strconv.Itoa(n) }
func itoa64(n int64) string { return strconv.FormatInt(n, 10) }

func notFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return errNotFound()
	}
	return err
}

func errNotFound() *apperr.Error { return apperr.NotFound("proposal.not_found") }
