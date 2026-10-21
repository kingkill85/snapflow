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
	"github.com/kingkill85/snapflow/backend/internal/platform/generation"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
	"github.com/kingkill85/snapflow/backend/internal/platform/money"
	"github.com/kingkill85/snapflow/backend/internal/platform/planimage"
)

// maxPlanPixels is the long side of a rendered plan image in a document;
// plan backgrounds are scaled down to it right after decoding.
const maxPlanPixels = 2400

// maxPlacementPixels is the long side catalog images are scaled down to
// right after decoding: a device is drawn far smaller on a plan.
const maxPlacementPixels = 256

// maxLogoPixels is the long side of the letterhead logo (45 mm at 300 dpi
// is about 530 px).
const maxLogoPixels = 800

// Generation limits (D268): the shared generation.Limiter bounds the runs
// at once (a run holds decoded plans and documents in memory); a run is
// cancelled after generationTimeout.
const generationTimeout = 2 * time.Minute

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
	// generating holds a slot per running generation (shared with the
	// installation documents).
	generating *generation.Limiter
	// sequencer reserves the proposal numbers (installation owns the
	// document counters, D456).
	sequencer Sequencer
}

// KindProposal is the document counter kind of proposals.
const KindProposal = "proposal"

// Sequencer reserves the next sequence of a version and document kind in
// the caller's transaction. Installation implements it (it imports this
// package, so the implementation is registered at wiring time, D456).
type Sequencer interface {
	NextSeq(ctx context.Context, tx pgx.Tx, versionID uuid.UUID, kind string) (int32, error)
}

// UseSequencer registers the owner of the document counters.
func (s *Service) UseSequencer(q Sequencer) { s.sequencer = q }

func NewService(db DB, projectSvc *projects.Service, bomSvc *bom.Service, planSvc *plans.Service, tenantSvc *tenants.Service,
	fileSvc *files.Service, userSvc *users.Service, exporters *document.Registry) *Service {
	return &Service{db: db, q: store.New(db), projects: projectSvc, bom: bomSvc, plans: planSvc, tenants: tenantSvc,
		files: fileSvc, users: userSvc, exporters: exporters, now: time.Now, generating: generation.New(generation.Default)}
}

// UseLimiter sets the generation limiter (at wiring time; one instance
// shared with the installation documents).
func (s *Service) UseLimiter(l *generation.Limiter) { s.generating = l }

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
				Currency:   r.Currency, Rate: trimRate(r.ExchangeRate), RateDate: r.ExchangeRateDate,
			},
		}
		if r.ExchangeRateSource != nil {
			p.Totals.RateSource = *r.ExchangeRateSource
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

// Delete removes a proposal and then its file, unless another row still
// references it (the same document bytes, D269).
func (s *Service) Delete(ctx context.Context, id uuid.UUID) error {
	actor, err := auth.Require(ctx, auth.PermProjectsDelete)
	if err != nil {
		return err
	}
	var fileID uuid.UUID
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, q *store.Queries) error {
		row, err := q.GetProposal(ctx, id)
		if err != nil {
			return notFound(err)
		}
		if _, err := s.projects.ReadVersion(ctx, tx, row.VersionID); err != nil {
			return err
		}
		fileID = row.FileID
		n, err := q.DeleteProposal(ctx, id)
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
	// Validated in the order sent (error indexes refer to it); duplicates
	// are harmless (SplitByProductType keeps BOM order, one part per type).
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
func (s *Service) Preview(ctx context.Context, versionID uuid.UUID, in PreviewInput) (ProposalPreview, error) {
	if _, err := auth.Require(ctx, auth.PermProjectsRead); err != nil {
		return ProposalPreview{}, err
	}
	b, err := s.bom.Get(ctx, versionID)
	if err != nil {
		return ProposalPreview{}, err
	}
	docs, err := documents(b, in.Split, in.ProductTypeIDs)
	if err != nil {
		return ProposalPreview{}, err
	}
	out := ProposalPreview{Documents: make([]PreviewDocument, len(docs))}
	for i, d := range docs {
		out.Documents[i] = PreviewDocument{Totals: d.bom.Totals}
		if d.productType != nil {
			out.Documents[i].ProductType = &NullableProposalProductType{ProposalProductType: ProposalProductType{ID: d.productType.ID, Name: d.productType.Name}}
		}
	}
	if in.Split {
		out.FreeText = freeTextShare(b, docs)
	}
	return out, nil
}

// freeTextShare is the combined grand total minus the grand totals of the
// split run's documents, when the version has free-text lines.
func freeTextShare(b bom.BOM, docs []document_) *NullableFreeTextShare {
	if !slices.ContainsFunc(b.Groups, func(g bom.BOMGroup) bool { return g.Kind == "freeText" }) {
		return nil
	}
	// Only a run over every product type reconciles to the combined total.
	types := 0
	for _, g := range b.Groups {
		if g.ProductType != nil {
			types++
		}
	}
	if len(docs) != types {
		return nil
	}
	usd := money.MustParse(b.Totals.GrandTotal)
	for _, d := range docs {
		usd = usd.Sub(money.MustParse(d.bom.Totals.GrandTotal))
	}
	out := &NullableFreeTextShare{FreeTextShare: FreeTextShare{GrandTotal: money.USD(usd)}}
	if c := b.Totals.Converted; c != nil {
		conv := money.MustParse(c.GrandTotal)
		for _, d := range docs {
			conv = conv.Sub(money.MustParse(d.bom.Totals.Converted.GrandTotal))
		}
		v := money.Format(conv, b.Totals.Currency)
		out.Converted = &v
	}
	return out
}

// Generate writes the proposals of a version.
func (s *Service) Generate(ctx context.Context, versionID uuid.UUID, in GenerateInput) ([]Proposal, error) {
	actor, err := auth.Require(ctx, auth.PermProjectsWrite)
	if err != nil {
		return nil, err
	}
	if s.sequencer == nil {
		return nil, errors.New("proposals: no sequencer registered")
	}
	exp, ok := s.exporters.Get(in.Exporter)
	if !ok {
		return nil, apperr.Invalid("body.exporter", "proposal.exporter_unknown", "unknown exporter").With("exporters", strings.Join(s.exporters.Keys(), ", "))
	}
	release, err := s.generating.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	ctx, cancel := context.WithTimeout(ctx, generationTimeout)
	defer cancel()
	r, err := s.read(ctx, actor, versionID, in)
	if err != nil {
		return nil, err
	}
	if r.bom.Totals.Currency != "USD" && r.bom.Totals.Rate == "" {
		return nil, apperr.Conflict("proposal.rate_missing", "set the project's exchange rate before generating a proposal").
			With("currency", r.bom.Totals.Currency)
	}
	pages, err := s.planPages(ctx, r)
	if err != nil {
		return nil, err
	}
	// Reserve the sequence (short transaction; a failed run leaves a gap).
	var seq int32
	err = s.inScope(ctx, actor, pgx.TxOptions{}, func(tx pgx.Tx, _ *store.Queries) error {
		seq, err = s.sequencer.NextSeq(ctx, tx, versionID, KindProposal)
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
		delete(pages, typeKey(d.productType)) // the document has its images now
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
			ExchangeRateDate: t.RateDate,
		}
		if t.RateSource != "" {
			p.ExchangeRateSource = &t.RateSource
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
		img, err := s.files.DecodeReferenced(ctx, *id, maxLogoPixels, maxImageBytes)
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
// always). Plans without zones and placements are left out. Every image is
// decoded once per run within the files' decode budget and scaled down at
// once; a plan's background is dropped as soon as its pages are drawn.
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
			img, err := s.files.DecodeReferenced(ctx, *snap.ImageFileID, maxPlacementPixels, maxImageBytes)
			if err != nil {
				return nil, err
			}
			images[*snap.ImageFileID] = img
		}
	}
	lang := tr(r.project.Language)
	out := map[string][]planPage{}
	for i := range docPlans {
		p := &docPlans[i]
		if len(p.Zones) == 0 && len(p.Placements) == 0 {
			p.Image = nil
			continue
		}
		bg, err := s.files.DecodeImage(ctx, p.Image, maxPlanPixels)
		p.Image = nil
		if err != nil {
			return nil, err
		}
		if bg == nil {
			continue // a plan whose image cannot be read is left out
		}
		for _, d := range r.parts {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			page, ok, err := renderPlan(*p, bg, snaps, images, d.productType, lang)
			if err != nil {
				return nil, err
			}
			if ok {
				key := typeKey(d.productType)
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

// renderPlan draws a plan for a document; bg is its background, possibly
// scaled down (coordinates refer to the plan's stored size).
func renderPlan(p plans.DocumentPlan, bg image.Image, snaps map[uuid.UUID]bom.VariantSnapshot, images map[uuid.UUID]image.Image,
	only *bom.SnapshotProductType, lang tr) (planPage, bool, error) {
	in := planimage.Plan{Background: bg, TextScale: planTextScale}
	if p.Width > 0 && p.Height > 0 {
		in.Size = image.Pt(int(p.Width), int(p.Height))
	}
	for _, z := range p.Zones {
		in.Zones = append(in.Zones, planimage.Zone{Name: z.Name, Color: hexColor(z.Color), Opacity: z.Opacity, Points: z.Points})
	}
	var legend []legendEntry
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
			i := slices.IndexFunc(legend, func(t legendEntry) bool { return t.name == name })
			if i < 0 {
				legend = append(legend, legendEntry{name: name})
				i = len(legend) - 1
			}
			if pl.Existing {
				legend[i].existing++
			} else {
				legend[i].count++
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
	return planPage{name: p.Name, image: img, existing: existing, legend: legend}, true, nil
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

// planTextScale: plans print at about 19-26 cm wide, where the editor's
// label size (1 % of the long side) is under 2 mm; 1.5× gives about 7 pt
// labels and 9 pt zone names (D271).
const planTextScale = 1.5
