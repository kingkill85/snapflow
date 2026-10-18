package imports

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/categories"
	"github.com/kingkill85/snapflow/backend/internal/features/files"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/attrschema"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
	"github.com/kingkill85/snapflow/backend/internal/platform/importsrc"
)

// StandardVariantName names the variant of a row without a variant name
// (D51).
const StandardVariantName = "Standard"

// planEntry is what apply does for one item (stored as import_items.plan).
// Existing entities carry the version the preview read; the catalog token
// guarantees it is still current when the run is applied.
type planEntry struct {
	// A category to create.
	Category *categories.CategoryInput `json:"category,omitempty"`
	// The product's state after the import; CategorySeq is set when its
	// category is one this run creates.
	Product     *products.ProductInput `json:"product,omitempty"`
	CategorySeq int                    `json:"categorySeq,omitempty"`
	// The variant's state after the import; ProductSeq is its product item.
	Variant    *products.VariantInput `json:"variant,omitempty"`
	ProductSeq int                    `json:"productSeq,omitempty"`
	// Addons is the variant's new add-on list, set when it changes.
	Addons *[]planAddon `json:"addons,omitempty"`
	// The existing entity and the version read.
	ID                *uuid.UUID `json:"id,omitempty"`
	ProductID         *uuid.UUID `json:"productId,omitempty"`
	ExpectedUpdatedAt time.Time  `json:"expectedUpdatedAt"`
	// Before is the stored state, for the change log.
	BeforeProduct *products.CatalogProduct `json:"beforeProduct,omitempty"`
	BeforeVariant *products.CatalogVariant `json:"beforeVariant,omitempty"`
}

// planAddon is an add-on of a variant's new list: an existing variant (ID)
// or one this run creates (Seq).
type planAddon struct {
	VariantID *uuid.UUID `json:"variantId,omitempty"`
	Seq       int        `json:"seq,omitempty"`
	Required  bool       `json:"required"`
	Label     string     `json:"label"`
}

type entry struct {
	item ImportItem
	plan planEntry
	// variant entries: file index keys, the existing variant, its rows'
	// add-on references.
	matchKeys []string
	existing  *products.CatalogVariant
	row       *rowData
	group     *group
}

// plan is a computed preview.
type plan struct {
	entries []*entry
	issues  []ImportIssue
	counts  ImportCounts
	// scope is what the plan read of the catalog (scopeToken).
	scope catalogScope
	// images are the files stored for the pictures, by part name.
	images map[string]uuid.UUID
}

type planInput struct {
	mapping    ImportMapping
	table      *importsrc.Table
	types      []producttypes.ProductType
	categories []categories.Category
	catalog    []products.CatalogProduct
	// storeImage stores a picture (reading its bytes) and returns its
	// file; an *apperr.Error means the picture is not usable
	// (import.image_invalid). It is called once per picture part, from
	// several goroutines at once.
	storeImage func(img importsrc.Image) (uuid.UUID, error)
}

type rowData struct {
	row      importsrc.Row
	model    string // as stored (NFC, white space collapsed)
	modelKey string // products.MatchKey
	failed   bool   // has errors
}

type group struct {
	key      string
	model    string
	rows     []*rowData
	pt       producttypes.ProductType
	cat      categories.Category
	catSeq   int // a category this run creates
	existing *products.CatalogProduct
	entry    *entry
	skipped  bool
	// present are the variant name keys the file lists (also on rows with
	// errors), so they are not deactivated.
	present map[string]bool
	// matched are the existing variants rows were matched to.
	matched map[uuid.UUID]bool
}

type planner struct {
	planInput
	cols    []column
	targets []target
	header  importsrc.Row
	idx     fieldIndex
	issues  []ImportIssue
	entries []*entry
	counts  ImportCounts
	images  map[string]*storedImage // by picture part name
	// counted are the pictures counted in Images.Files.
	counted map[string]bool
	// fatal is an error storing a picture that is not the picture's fault
	// (the disk, say): the preview fails.
	fatal error
	scope catalogScope
	// attrKeys are the mapped attribute keys, sorted.
	attrKeys []string
	// new categories by key
	newCategories map[string]*entry
	typeByID      map[uuid.UUID]producttypes.ProductType
	categoryByID  map[uuid.UUID]categories.Category
	// constType and constCategory are the product type and category of a
	// constant (resolved once).
	constType     *producttypes.ProductType
	constCategory *categories.Category
	rowsWithErrs  map[int]bool
	// SKUs: of the file's rows so far, of the catalog's variants.
	skusInFile map[string]bool
	skuOwners  map[string]*products.CatalogVariant
}

type storedImage struct {
	id   uuid.UUID
	err  error
	done bool
}

// fieldIndex is where each target is mapped (-1: not mapped).
type fieldIndex struct {
	model, ptype, category, sku, price, image int
	pname, pdesc, vname                       map[string]int
	attrs                                     map[string]int
	addons                                    []int
}

func buildPlan(in planInput, loc string) (*plan, error) {
	p := &planner{planInput: in, images: map[string]*storedImage{}, counted: map[string]bool{}, newCategories: map[string]*entry{},
		typeByID: map[uuid.UUID]producttypes.ProductType{}, categoryByID: map[uuid.UUID]categories.Category{},
		rowsWithErrs: map[int]bool{}, skusInFile: map[string]bool{}, skuOwners: map[string]*products.CatalogVariant{}}
	for _, t := range in.types {
		p.typeByID[t.ID] = t
	}
	for _, c := range in.categories {
		p.categoryByID[c.ID] = c
	}
	for i := range in.catalog {
		for j := range in.catalog[i].Variants {
			if v := &in.catalog[i].Variants[j]; v.SKU != "" {
				p.skuOwners[products.MatchKey(v.SKU)] = v
			}
		}
	}
	p.targets = make([]target, len(in.mapping.Fields))
	p.idx = fieldIndex{model: -1, ptype: -1, category: -1, sku: -1, price: -1, image: -1,
		pname: map[string]int{}, pdesc: map[string]int{}, vname: map[string]int{}, attrs: map[string]int{}}
	for i, f := range in.mapping.Fields {
		t, _ := parseTarget(f.Target)
		p.targets[i] = t
		switch t.kind {
		case tModelNumber:
			p.idx.model = i
		case tProductType:
			p.idx.ptype = i
		case tCategory:
			p.idx.category = i
		case tVariantSKU:
			p.idx.sku = i
		case tVariantPrice:
			p.idx.price = i
		case tVariantImage:
			p.idx.image = i
		case tProductName:
			p.idx.pname[t.locale] = i
		case tProductDescription:
			p.idx.pdesc[t.locale] = i
		case tVariantName:
			p.idx.vname[t.locale] = i
		case tAttribute:
			p.idx.attrs[t.key] = i
			p.attrKeys = append(p.attrKeys, t.key)
		case tAddonRequired, tAddonOptional:
			p.idx.addons = append(p.idx.addons, i)
		}
	}

	slices.Sort(p.attrKeys)
	var data []importsrc.Row
	for _, r := range in.table.Rows {
		switch {
		case r.Number == in.mapping.HeaderRow:
			p.header = r
		case r.Number >= in.mapping.DataStartRow && !textBlank(r):
			data = append(data, r)
		}
	}
	cols, errs := resolveColumns(in.mapping, p.header, loc)
	if len(errs) > 0 {
		return nil, apperr.Validation(errs...)
	}
	p.cols = cols
	if len(data) == 0 {
		return nil, apperr.New(http.StatusUnprocessableEntity, "import.no_rows", "the file has no data rows")
	}
	if len(data) > MaxRows {
		return nil, apperr.New(http.StatusUnprocessableEntity, "import.too_many_rows", "the sheet has too many rows").With("max", MaxRows)
	}
	if err := p.resolveConstants(loc); err != nil {
		return nil, err
	}
	p.counts.Rows = len(data)
	p.counts.Unmapped = p.unmapped()

	groups := p.group(data)
	p.storeImages(data)
	for _, g := range groups {
		p.planProduct(g)
	}
	p.planDeactivations(groups)
	p.skipUnusedCategories(groups)
	p.planAddons()
	p.countImages()
	if p.fatal != nil {
		return nil, p.fatal
	}

	p.linkIssues()
	p.counts.RowsSkipped = len(p.rowsWithErrs)
	for _, is := range p.issues {
		if is.Severity == "error" {
			p.counts.Errors++
		} else {
			p.counts.Warnings++
		}
	}
	// Categories first: products refer to them.
	ordered := []*entry{}
	for _, e := range p.entries {
		if e.item.Entity == "category" {
			ordered = append(ordered, e)
		}
	}
	for _, e := range p.entries {
		if e.item.Entity != "category" {
			ordered = append(ordered, e)
		}
	}
	images := map[string]uuid.UUID{}
	for name, s := range p.images {
		if s.err == nil && s.done {
			images[name] = s.id
		}
	}
	p.scope.normalize()
	return &plan{entries: ordered, issues: p.issues, counts: p.counts, scope: p.scope, images: images}, nil
}

// linkIssues gives each row issue the diff item of its row (its variant, or
// its product when no variant was planned), so the preview can link them.
func (p *planner) linkIssues() {
	seqs := map[int]int{}
	for _, e := range p.entries {
		switch {
		case e.item.Entity == "product":
			for _, r := range e.item.Rows {
				if _, ok := seqs[r]; !ok {
					seqs[r] = e.item.Seq
				}
			}
		case e.item.Entity == "variant" && e.row != nil:
			seqs[e.row.row.Number] = e.item.Seq
		}
	}
	for i := range p.issues {
		if is := &p.issues[i]; is.Row > 0 && is.ItemSeq == 0 {
			is.ItemSeq = seqs[is.Row]
		}
	}
}

// skipUnusedCategories skips new categories whose products are all
// skipped (rows with errors), so no empty category is created.
func (p *planner) skipUnusedCategories(groups []*group) {
	used := map[int]bool{}
	for _, g := range groups {
		if !g.skipped && g.catSeq != 0 {
			used[g.catSeq] = true
		}
	}
	for _, e := range p.newCategories {
		e.item.Skipped = !used[e.item.Seq]
	}
}

// textBlank reports a row without text; a picture alone does not make a
// data row (spacer rows).
func textBlank(r importsrc.Row) bool {
	for _, c := range r.Cells {
		if strings.TrimSpace(c) != "" {
			return false
		}
	}
	return true
}

func (p *planner) unmapped() []ImportSourceColumn {
	used := map[int]bool{}
	for _, c := range p.cols {
		if c.index >= 0 {
			used[c.index] = true
		}
	}
	out := []ImportSourceColumn{}
	for col, h := range p.header.Cells {
		if !used[col] && strings.TrimSpace(h) != "" {
			out = append(out, ImportSourceColumn{Letter: importsrc.ColumnName(col), Header: products.CollapseSpace(h)})
		}
	}
	return out
}

func (p *planner) cell(r importsrc.Row, field int) string {
	if field < 0 {
		return ""
	}
	c := p.cols[field]
	switch {
	case c.constant:
		return c.value
	case c.index < 0:
		return ""
	}
	return r.Cell(c.index)
}

// issue records a row error or warning at a mapped field (-1: none).
func (p *planner) issue(severity string, row *rowData, field int, code string, params map[string]any) {
	is := ImportIssue{Severity: severity, Code: code, Params: params}
	if row != nil {
		is.Row, is.ModelNumber = row.row.Number, row.model
		if severity == "error" {
			row.failed = true
			p.rowsWithErrs[row.row.Number] = true
		}
	}
	if field >= 0 {
		is.Target = p.mapping.Fields[field].Target
		if c := p.cols[field]; c.index >= 0 {
			is.Column = importsrc.ColumnName(c.index)
			is.Header = products.CollapseSpace(p.header.Cell(c.index))
		}
	}
	p.issues = append(p.issues, is)
}

// fieldIssue records a validation error from the products service's
// normalisers (bare locations such as "name.en", "attributes.width_te[2]")
// at the field that feeds it; without one, the issue names the target.
func (p *planner) fieldIssue(row *rowData, fe apperr.FieldError, variant bool) {
	loc := fe.Location
	field, target := -1, ""
	switch {
	case loc == "modelNumber":
		field = p.idx.model
	case loc == "productTypeId":
		field = p.idx.ptype
	case loc == "categoryId":
		field = p.idx.category
	case loc == "sku":
		field, target = p.idx.sku, "variant.sku"
	case loc == "price":
		field, target = p.idx.price, "variant.price"
	case strings.HasPrefix(loc, "name"):
		prefix, names := "product.name.", p.idx.pname
		if variant {
			prefix, names = "variant.name.", p.idx.vname
		}
		l := localeOf(loc[len("name"):])
		field, target = lookup(names, l), prefix+l
	case strings.HasPrefix(loc, "description"):
		l := localeOf(loc[len("description"):])
		field, target = lookup(p.idx.pdesc, l), "product.description."+l
	case strings.HasPrefix(loc, "attributes."):
		key := strings.TrimPrefix(loc, "attributes.")
		if i := strings.IndexByte(key, '['); i >= 0 {
			key = key[:i]
		}
		field, target = lookup(p.idx.attrs, key), "attribute."+key
	}
	p.issue("error", row, field, fe.Code, fe.Params)
	if field < 0 && target != "" {
		p.issues[len(p.issues)-1].Target = target
	}
}

// localeOf reads the locale of a location rest such as ".de" (the default
// locale for the whole text).
func localeOf(rest string) string {
	if l, ok := strings.CutPrefix(rest, "."); ok {
		return l
	}
	return i18n.DefaultLocale
}

func lookup(m map[string]int, key string) int {
	if i, ok := m[key]; ok {
		return i
	}
	return -1
}

// group parses model numbers and groups the rows by model number (first
// appearance order). Rows without one are errors.
func (p *planner) group(data []importsrc.Row) []*group {
	byKey := map[string]*group{}
	groups := []*group{}
	for _, r := range data {
		rd := &rowData{row: r}
		rd.model = products.BusinessKey(products.CollapseSpace(p.cell(r, p.idx.model)))
		rd.modelKey = products.MatchKey(rd.model)
		if p.idx.sku >= 0 {
			if sku := products.MatchKey(p.cell(r, p.idx.sku)); sku != "" {
				p.scope.SKUKeys = append(p.scope.SKUKeys, sku)
			}
		}
		if rd.model == "" {
			p.issue("error", rd, p.idx.model, "validation.required", nil)
			continue
		}
		g := byKey[rd.modelKey]
		if g == nil {
			g = &group{key: rd.modelKey, model: rd.model, present: map[string]bool{}, matched: map[uuid.UUID]bool{}}
			byKey[rd.modelKey] = g
			groups = append(groups, g)
			p.scope.ModelKeys = append(p.scope.ModelKeys, rd.modelKey)
		}
		g.rows = append(g.rows, rd)
	}
	catalog := map[string]*products.CatalogProduct{}
	for i := range p.catalog {
		catalog[products.MatchKey(p.catalog[i].ModelNumber)] = &p.catalog[i]
	}
	for _, g := range groups {
		g.existing = catalog[g.key]
	}
	return groups
}

var slugPattern = regexp.MustCompile(`[^a-z0-9]+`)

// categoryKey derives a category key from a name: lower snake case, at most
// 64 characters, starting with a letter ("category_" before a digit).
func categoryKey(name string) string {
	k := strings.Trim(slugPattern.ReplaceAllString(strings.ToLower(name), "_"), "_")
	if k != "" && (k[0] < 'a' || k[0] > 'z') {
		k = "category_" + k
	}
	if len(k) > categories.MaxKeyLength {
		k = strings.TrimRight(k[:categories.MaxKeyLength], "_")
	}
	return k
}

// matchKey is how product type and category values are compared: white
// space collapsed, ignoring case.
func matchKey(s string) string { return strings.ToLower(products.CollapseSpace(s)) }

// findType matches a value against the product types' keys, English names
// and abbreviations (ignoring case and repeated white space).
func (p *planner) findType(value string) (producttypes.ProductType, bool) {
	want := matchKey(value)
	for _, t := range p.types {
		if strings.ToLower(t.Key) == want || matchKey(t.Name[i18n.DefaultLocale]) == want ||
			(t.Abbreviation != "" && matchKey(t.Abbreviation) == want) {
			return t, true
		}
	}
	return producttypes.ProductType{}, false
}

// findCategory matches a value against the categories' keys (also the key
// derived from the value) and English names, ignoring case and repeated
// white space.
func (p *planner) findCategory(value string) (categories.Category, bool) {
	want, key := matchKey(value), categoryKey(value)
	for _, c := range p.categories {
		if c.Key == want || c.Key == key || matchKey(c.Name[i18n.DefaultLocale]) == want {
			return c, true
		}
	}
	return categories.Category{}, false
}

// resolveConstants resolves a product type or category given as a constant
// once. An unknown one is a mistake in the profile, not in the rows: the
// preview is refused (422 at the field's value), except for a category
// that CreateMissingCategories creates.
func (p *planner) resolveConstants(loc string) error {
	errs := []apperr.FieldError{}
	if p.mapping.CategoryID != nil {
		p.scope.CategoryIDs = append(p.scope.CategoryIDs, *p.mapping.CategoryID)
	}
	if p.mapping.ProductTypeID != nil {
		p.scope.TypeIDs = append(p.scope.TypeIDs, *p.mapping.ProductTypeID)
	}
	if i := p.idx.ptype; i >= 0 && p.cols[i].constant {
		value := products.CollapseSpace(p.cols[i].value)
		p.scope.TypeValues = append(p.scope.TypeValues, value)
		if t, ok := p.findType(value); ok {
			p.constType = &t
			p.scope.TypeIDs = append(p.scope.TypeIDs, t.ID)
		} else {
			errs = append(errs, apperr.Field(fmt.Sprintf("%s.fields[%d].value", loc, i), "import.product_type_unknown",
				"no such product type; create it first").With("value", value))
		}
	}
	if i := p.idx.category; i >= 0 && p.cols[i].constant {
		value := products.CollapseSpace(p.cols[i].value)
		p.scope.CategoryValues = append(p.scope.CategoryValues, value)
		if c, ok := p.findCategory(value); ok {
			p.constCategory = &c
			p.scope.CategoryIDs = append(p.scope.CategoryIDs, c.ID)
		} else if !p.mapping.CreateMissingCategories || categoryKey(value) == "" {
			errs = append(errs, apperr.Field(fmt.Sprintf("%s.fields[%d].value", loc, i), "import.category_unknown",
				"no such category").With("value", value))
		}
	}
	if len(errs) > 0 {
		return apperr.Validation(errs...)
	}
	return nil
}

// resolveType finds a row's product type (system): the profile's fixed
// type or constant, or the column's value matched by key, English name or
// abbreviation. Unknown values are row errors: the import never creates
// product types.
func (p *planner) resolveType(rd *rowData) (producttypes.ProductType, bool) {
	switch {
	case p.mapping.ProductTypeID != nil:
		return p.typeByID[*p.mapping.ProductTypeID], true
	case p.constType != nil:
		return *p.constType, true
	}
	value := products.CollapseSpace(p.cell(rd.row, p.idx.ptype))
	if value == "" {
		p.issue("error", rd, p.idx.ptype, "validation.required", nil)
		return producttypes.ProductType{}, false
	}
	p.scope.TypeValues = append(p.scope.TypeValues, value)
	if t, ok := p.findType(value); ok {
		p.scope.TypeIDs = append(p.scope.TypeIDs, t.ID)
		return t, true
	}
	p.issue("error", rd, p.idx.ptype, "import.product_type_unknown", map[string]any{"value": value})
	return producttypes.ProductType{}, false
}

// resolveCategory finds a row's category: the profile's fixed category or
// constant, or the column's value matched by key (also the key derived from
// the value) or English name. Unknown names are errors, or new categories
// with CreateMissingCategories (the int is the new category's item seq).
func (p *planner) resolveCategory(rd *rowData) (categories.Category, int, bool) {
	switch {
	case p.mapping.CategoryID != nil:
		return p.categoryByID[*p.mapping.CategoryID], 0, true
	case p.constCategory != nil:
		return *p.constCategory, 0, true
	}
	value := products.CollapseSpace(p.cell(rd.row, p.idx.category))
	if value == "" {
		p.issue("error", rd, p.idx.category, "validation.required", nil)
		return categories.Category{}, 0, false
	}
	p.scope.CategoryValues = append(p.scope.CategoryValues, value)
	if c, ok := p.findCategory(value); ok {
		p.scope.CategoryIDs = append(p.scope.CategoryIDs, c.ID)
		return c, 0, true
	}
	key := categoryKey(value)
	if !p.mapping.CreateMissingCategories || key == "" {
		p.issue("error", rd, p.idx.category, "import.category_unknown", map[string]any{"value": value})
		return categories.Category{}, 0, false
	}
	if utf8.RuneCountInString(value) > categories.MaxNameLength {
		p.issue("error", rd, p.idx.category, "validation.too_long", map[string]any{"max": categories.MaxNameLength})
		return categories.Category{}, 0, false
	}
	e := p.newCategories[key]
	if e == nil {
		e = p.newCategoryEntry(key, value)
	}
	in := e.plan.Category
	return categories.Category{IsActive: true, Key: key, Name: in.Name, Attributes: in.Attributes}, e.item.Seq, true
}

// newCategoryEntry plans a category the file names but the catalog lacks:
// active, with a text attribute (product scope) per mapped attribute key, so
// the mapped columns have somewhere to go; an admin tightens the schema
// afterwards.
func (p *planner) newCategoryEntry(key, name string) *entry {
	schema := attrschema.Schema{}
	for i, f := range p.mapping.Fields {
		t := p.targets[i]
		if t.kind != tAttribute {
			continue
		}
		label := products.CollapseSpace(f.Column)
		if label == "" || p.cols[i].constant {
			label = humanize(t.key)
		}
		schema = append(schema, attrschema.AttributeDefinition{
			Definition: attrschema.Definition{Key: t.key, Label: i18n.Text{"en": truncate(label, attrschema.MaxLabelLength)}, Type: attrschema.TypeText},
			Scope:      attrschema.ScopeProduct,
		})
	}
	input := categories.CategoryInput{
		Key: key, Name: i18n.Text{"en": name}, IsActive: true, Attributes: schema, InstanceAttributes: attrschema.InstanceSchema{},
	}
	e := &entry{item: ImportItem{Seq: len(p.entries) + 1, Entity: "category", Status: "new", Key: key, Name: input.Name,
		Changes: []ImportFieldChange{{Field: "key", After: key}, {Field: "name.en", After: name}}}}
	for _, a := range schema {
		e.item.Changes = append(e.item.Changes, ImportFieldChange{Field: "attributes." + a.Key, After: string(a.Type)})
	}
	e.plan.Category = &input
	p.entries = append(p.entries, e)
	p.newCategories[key] = e
	p.counts.Categories.New++
	return e
}

func humanize(key string) string {
	s := strings.ReplaceAll(key, "_", " ")
	return strings.ToUpper(s[:1]) + s[1:]
}

func truncate(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	return string([]rune(s)[:max])
}

// planProduct plans a product (from its first row) and its variants (one
// per row).
func (p *planner) planProduct(g *group) {
	first := g.rows[0]
	pt, typeOK := p.resolveType(first)
	cat, catSeq, catOK := p.resolveCategory(first)
	ok := typeOK && catOK
	g.pt, g.cat, g.catSeq = pt, cat, catSeq
	if ce := p.newCategories[cat.Key]; catSeq != 0 && ce != nil {
		for _, r := range g.rows {
			ce.item.Rows = append(ce.item.Rows, r.row.Number)
		}
	}
	e := &entry{item: ImportItem{Seq: len(p.entries) + 1, Entity: "product", ModelNumber: g.model}, group: g}
	p.entries = append(p.entries, e)
	g.entry = e
	for _, r := range g.rows {
		e.item.Rows = append(e.item.Rows, r.row.Number)
	}
	if !ok {
		g.skipped = true
		e.item.Skipped = true
		e.item.Status = "new"
		if g.existing != nil {
			e.item.Status, e.item.ID = "unchanged", &g.existing.ID
		}
		e.item.Changes = []ImportFieldChange{}
		p.markRows(g)
		p.countItem(&p.counts.Products, e.item.Status)
		return
	}

	// Later rows only add variants; conflicting product fields are
	// warnings (the first row wins).
	productFields := []int{p.idx.ptype, p.idx.category}
	for _, i := range p.idx.pname {
		productFields = append(productFields, i)
	}
	for _, i := range p.idx.pdesc {
		productFields = append(productFields, i)
	}
	for _, key := range p.attrKeys {
		if def, found := findAttr(cat.Attributes, key); found && def.Scope != attrschema.ScopeVariant {
			productFields = append(productFields, p.idx.attrs[key])
		}
	}
	slices.Sort(productFields)
	for _, r := range g.rows[1:] {
		for _, f := range productFields {
			if f < 0 || p.cols[f].constant {
				continue
			}
			later := products.CollapseSpace(p.cell(r.row, f))
			if later != "" && later != products.CollapseSpace(p.cell(first.row, f)) {
				p.issue("warning", r, f, "import.product_field_conflict", map[string]any{"field": p.mapping.Fields[f].Target})
			}
		}
	}

	after := products.ProductInput{ProductTypeID: pt.ID, CategoryID: cat.ID, ModelNumber: g.model, IsActive: true,
		Name: i18n.Text{}, Description: i18n.Text{}, Attributes: attrschema.Values{}}
	var existing *products.Existing
	if g.existing != nil {
		after.Name, after.Description = cloneText(g.existing.Name), cloneText(g.existing.Description)
		after.Attributes = cloneValues(g.existing.Attributes)
		existing = &products.Existing{ProductTypeID: g.existing.ProductTypeID, CategoryID: g.existing.CategoryID, Attributes: g.existing.Attributes}
	}
	for locale, i := range p.idx.pname {
		setText(after.Name, locale, p.cell(first.row, i))
	}
	for locale, i := range p.idx.pdesc {
		setText(after.Description, locale, p.cell(first.row, i))
	}
	p.applyAttributes(first, cat, attrschema.ScopeProduct, after.Attributes)
	normalized, errs := products.NormalizeProduct(pt, cat, after, existing, "")
	if catSeq != 0 {
		// The category does not exist yet; it is active when created.
		errs = slices.DeleteFunc(errs, func(fe apperr.FieldError) bool { return fe.Code == "product.category_inactive" })
	}
	for _, fe := range errs {
		p.fieldIssue(first, fe, false)
	}
	e.plan.Product, e.plan.CategorySeq = &normalized, catSeq
	e.item.Name = normalized.Name
	e.item.ProductType, e.item.Category = typeRef(pt), categoryRef(cat, catSeq)
	if g.existing != nil {
		e.item.ID = &g.existing.ID
		e.plan.ID, e.plan.ExpectedUpdatedAt = &g.existing.ID, g.existing.UpdatedAt
		before := *g.existing
		before.Variants = nil
		e.plan.BeforeProduct = &before
	}
	e.item.Changes = p.productChanges(g.existing, normalized, pt, cat, catSeq)
	e.item.Status = status(g.existing != nil, len(e.item.Changes))
	if first.failed {
		g.skipped = true
		e.item.Skipped = true
		p.markRows(g)
	}
	p.countItem(&p.counts.Products, e.item.Status)

	for _, r := range g.rows {
		p.planVariant(g, r)
	}
	if !g.skipped && !slices.ContainsFunc(g.rows, func(r *rowData) bool { return !r.failed }) {
		// Every row has errors: the product is not written either (its
		// variants are skipped with their rows).
		g.skipped = true
		e.item.Skipped = true
		p.markRows(g)
	}
	if !g.skipped && g.existing != nil {
		for i := range g.existing.Variants {
			v := &g.existing.Variants[i]
			if !g.present[nameKey(v.Name["en"])] && !g.matched[v.ID] && v.IsActive {
				ve := &entry{item: ImportItem{Seq: len(p.entries) + 1, Entity: "variant", Status: "deactivate", ID: &v.ID,
					ProductID: &g.existing.ID, ModelNumber: g.model, Name: v.Name, SKU: v.SKU,
					Changes: []ImportFieldChange{{Field: "isActive", Before: true, After: false}}}, group: g}
				ve.plan.ID, ve.plan.ProductID, ve.plan.ExpectedUpdatedAt = &v.ID, &g.existing.ID, v.UpdatedAt
				ve.plan.ProductSeq = g.entry.item.Seq
				before := *v
				ve.plan.BeforeVariant = &before
				p.entries = append(p.entries, ve)
				p.counts.Variants.Deactivate++
			}
		}
	}
}

// markRows flags every row of a skipped product.
func (p *planner) markRows(g *group) {
	for _, r := range g.rows {
		p.rowsWithErrs[r.row.Number] = true
	}
}

func typeRef(pt producttypes.ProductType) *ImportTypeRef {
	return &ImportTypeRef{ID: pt.ID, Key: pt.Key, Name: pt.Name, Abbreviation: pt.Abbreviation, Color: pt.Color}
}

func categoryRef(c categories.Category, catSeq int) *ImportCategoryRef {
	ref := &ImportCategoryRef{Key: c.Key, Name: c.Name}
	if catSeq == 0 {
		id := c.ID
		ref.ID = &id
	}
	return ref
}

func findAttr(schema attrschema.Schema, key string) (attrschema.AttributeDefinition, bool) {
	for _, a := range schema {
		if a.Key == key {
			if a.Scope == "" {
				a.Scope = attrschema.ScopeProduct
			}
			return a, true
		}
	}
	return attrschema.AttributeDefinition{}, false
}

// applyAttributes sets the mapped attributes of one scope from a row:
// parsed leniently (D32), blank cells remove the value. A value for a key
// the category's schema lacks is an error (D31: imports reject unknown
// keys); a blank cell of such a column is nothing to import (a constant
// always counts).
func (p *planner) applyAttributes(r *rowData, c categories.Category, scope attrschema.Scope, values attrschema.Values) {
	for _, key := range p.attrKeys {
		i := p.idx.attrs[key]
		def, found := findAttr(c.Attributes, key)
		if !found {
			blank := !p.cols[i].constant && strings.TrimSpace(p.cell(r.row, i)) == ""
			if scope == attrschema.ScopeProduct && !blank { // reported once per row
				p.issue("error", r, i, "attribute.unknown", nil)
			}
			continue
		}
		if def.Scope != scope {
			continue
		}
		if v := attrschema.ParseCell(def.Definition, p.cell(r.row, i)); v != nil {
			values[key] = v
		} else {
			delete(values, key)
		}
	}
}

// planVariant plans the variant of one row.
func (p *planner) planVariant(g *group, r *rowData) {
	name := i18n.Text{}
	for locale, i := range p.idx.vname {
		setText(name, locale, p.cell(r.row, i))
	}
	fromBlank := strings.TrimSpace(name["en"]) == ""
	if fromBlank {
		name["en"] = StandardVariantName
	}
	key := nameKey(name["en"])
	e := &entry{item: ImportItem{Seq: len(p.entries) + 1, Entity: "variant", ModelNumber: g.model, Rows: []int{r.row.Number}}, group: g, row: r}
	if g.present[key] {
		p.issue("error", r, lookup(p.idx.vname, i18n.DefaultLocale), "import.duplicate_variant", map[string]any{"name": name["en"]})
	}
	g.present[key] = true
	var existing *products.CatalogVariant
	if g.existing != nil {
		for i := range g.existing.Variants {
			if v := &g.existing.Variants[i]; nameKey(v.Name["en"]) == key && !g.matched[v.ID] {
				existing = v
				break
			}
		}
	}

	sku := ""
	if p.idx.sku >= 0 {
		sku = products.BusinessKey(products.CollapseSpace(p.cell(r.row, p.idx.sku)))
	}
	if existing == nil && sku != "" && g.existing != nil {
		for i := range g.existing.Variants {
			if v := &g.existing.Variants[i]; products.MatchKey(v.SKU) == products.MatchKey(sku) && !g.matched[v.ID] {
				existing = v
				break
			}
		}
	}
	e.existing = existing
	if existing != nil {
		g.matched[existing.ID] = true
	}
	if sku != "" {
		if p.skusInFile[products.MatchKey(sku)] {
			p.issue("error", r, p.idx.sku, "import.duplicate_sku", map[string]any{"sku": sku})
		}
		p.skusInFile[products.MatchKey(sku)] = true
		if owner := p.skuOwners[products.MatchKey(sku)]; owner != nil && (existing == nil || owner.ID != existing.ID) {
			p.issue("error", r, p.idx.sku, "variant.sku_taken", map[string]any{"sku": sku})
		}
	}

	after := products.VariantInput{Name: name, SKU: sku, IsActive: true, Attributes: attrschema.Values{}}
	var previous attrschema.Values
	if existing != nil {
		after.Name = cloneText(existing.Name)
		for l, v := range name {
			after.Name[l] = v
		}
		for l, i := range p.idx.vname {
			if strings.TrimSpace(p.cell(r.row, i)) == "" && l != i18n.DefaultLocale {
				delete(after.Name, l)
			}
		}
		if p.idx.sku < 0 {
			after.SKU = existing.SKU
		}
		after.Price, after.ImageFileID = existing.Price, existing.ImageFileID
		after.Attributes = cloneValues(existing.Attributes)
		previous = existing.Attributes
	}
	priceReported := false
	if p.idx.price >= 0 {
		raw := strings.TrimSpace(p.cell(r.row, p.idx.price))
		price, ok := attrschema.ParseDecimal(raw)
		switch {
		case raw == "":
			p.issue("error", r, p.idx.price, "validation.required", nil)
			priceReported = true
		case !ok:
			p.issue("error", r, p.idx.price, "variant.price_format", nil)
			priceReported = true
		default:
			if rounded, ok := roundPrice(price); ok && !p.cols[p.idx.price].constant {
				// A computed price (32.725 shown as 32,73): to the cent,
				// half up, with a warning.
				p.issue("warning", r, p.idx.price, "import.price_rounded", map[string]any{"value": raw, "rounded": rounded})
				price = rounded
			}
			after.Price = price
		}
	}
	p.applyAttributes(r, g.cat, attrschema.ScopeVariant, after.Attributes)
	if p.idx.image >= 0 {
		if id := p.rowImage(g, r); id != nil {
			after.ImageFileID = id
		}
	}
	normalized, errs := products.NormalizeVariant(g.cat, after, previous, "")
	for _, fe := range errs {
		if fe.Location == "price" && priceReported {
			continue // already reported from the cell
		}
		p.fieldIssue(r, fe, true)
	}
	e.plan.Variant, e.plan.ProductSeq = &normalized, g.entry.item.Seq
	e.item.Name, e.item.SKU = normalized.Name, normalized.SKU
	e.matchKeys = []string{products.MatchKey(g.model + " " + normalized.Name["en"])}
	if normalized.SKU != "" {
		e.matchKeys = append(e.matchKeys, products.MatchKey(normalized.SKU))
	}
	if fromBlank {
		e.matchKeys = append(e.matchKeys, products.MatchKey(g.model))
	}
	if g.existing != nil {
		e.item.ProductID, e.plan.ProductID = &g.existing.ID, &g.existing.ID
	}
	if existing != nil {
		e.item.ID, e.plan.ID, e.plan.ExpectedUpdatedAt = &existing.ID, &existing.ID, existing.UpdatedAt
		before := *existing
		e.plan.BeforeVariant = &before
	}
	e.item.Changes = variantChanges(existing, normalized)
	e.item.Status = status(existing != nil, len(e.item.Changes))
	e.item.Skipped = g.skipped || r.failed
	if e.item.Skipped {
		p.rowsWithErrs[r.row.Number] = true
	}
	p.entries = append(p.entries, e)
	p.countItem(&p.counts.Variants, e.item.Status)
}

// rowImage returns the row's picture (the first by anchor precedence, in
// the mapped column or any column), else the first picture of the
// product's rows in row order (SnapFlow 1, inventory 01 G102), stored as a
// file. Nil keeps the variant's current image.
func (p *planner) rowImage(g *group, r *rowData) *uuid.UUID {
	if id := p.ownImage(r, true); id != nil {
		return id
	}
	for _, other := range g.rows {
		if other != r {
			if id := p.ownImage(other, false); id != nil {
				return id
			}
		}
	}
	return nil
}

func (p *planner) ownImage(r *rowData, report bool) *uuid.UUID {
	col := p.cols[p.idx.image].index
	for _, img := range r.row.Images {
		if col >= 0 && img.Column != col {
			continue
		}
		s := p.images[img.Name]
		if s == nil {
			s = &storedImage{}
			p.images[img.Name] = s
		}
		if !s.done {
			p.store(img, s)
		}
		if !p.counted[img.Name] {
			p.counted[img.Name] = true
			var ae *apperr.Error
			switch {
			case s.err == nil:
				p.counts.Images.Files++
			case !errors.As(s.err, &ae):
				p.fatal = s.err
			}
		}
		if s.err != nil {
			if report {
				code := "file.type"
				var ae *apperr.Error
				if errors.As(s.err, &ae) {
					code = ae.Code
				}
				p.issue("warning", r, p.idx.image, "import.image_invalid", map[string]any{"reason": code})
			}
			continue
		}
		id := s.id
		return &id
	}
	return nil
}

// store stores one picture (or notes why it cannot be).
func (p *planner) store(img importsrc.Image, s *storedImage) {
	if img.TooLarge {
		s.err = importsrc.ErrImageTooLarge(files.MaxSize)
	} else {
		s.id, s.err = p.storeImage(img)
	}
	s.done = true
}

// storeImages stores the first picture of each data row (the one a variant
// most likely takes) up front, several at once: decoding and re-encoding
// pictures is most of a preview's time. The files service bounds the memory
// of the decodes running at once (files.DecodeBudget). Pictures needed
// later (a row's first picture was refused) are stored when needed.
func (p *planner) storeImages(data []importsrc.Row) {
	if p.idx.image < 0 {
		return
	}
	col := p.cols[p.idx.image].index
	var jobs []importsrc.Image
	for _, r := range data {
		for _, img := range r.Images {
			if col >= 0 && img.Column != col {
				continue
			}
			if p.images[img.Name] == nil {
				p.images[img.Name] = &storedImage{}
				jobs = append(jobs, img)
			}
			break
		}
	}
	work := make(chan importsrc.Image)
	var wg sync.WaitGroup
	for range min(len(jobs), max(2, min(runtime.GOMAXPROCS(0), 8))) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for img := range work {
				p.store(img, p.images[img.Name]) // each entry has one writer
			}
		}()
	}
	for _, img := range jobs {
		work <- img
	}
	close(work)
	wg.Wait()
}

// planDeactivations deactivates the products of the import's scope that
// the file does not list (D123): the pairs of product type and category the
// file's rows have (also rows with errors, as far as both resolved), or the
// profile's fixed pair. Products of other systems or other categories are
// never touched.
func (p *planner) planDeactivations(groups []*group) {
	type pair struct{ typeID, categoryID uuid.UUID }
	scope := map[pair]bool{}
	if p.mapping.ProductTypeID != nil && p.mapping.CategoryID != nil {
		scope[pair{*p.mapping.ProductTypeID, *p.mapping.CategoryID}] = true
	}
	present := map[string]bool{}
	for _, g := range groups {
		present[g.key] = true
		if g.catSeq == 0 && g.pt.ID != uuid.Nil && g.cat.ID != uuid.Nil {
			scope[pair{g.pt.ID, g.cat.ID}] = true
		}
	}
	for k := range scope {
		p.scope.Pairs = append(p.scope.Pairs, [2]uuid.UUID{k.typeID, k.categoryID})
	}
	for i := range p.catalog {
		c := &p.catalog[i]
		if !scope[pair{c.ProductTypeID, c.CategoryID}] || present[products.MatchKey(c.ModelNumber)] || !c.IsActive {
			continue
		}
		e := &entry{item: ImportItem{Seq: len(p.entries) + 1, Entity: "product", Status: "deactivate", ID: &c.ID,
			ModelNumber: c.ModelNumber, Name: c.Name, Rows: []int{},
			ProductType: typeRef(p.typeByID[c.ProductTypeID]), Category: categoryRef(p.categoryByID[c.CategoryID], 0),
			Changes: []ImportFieldChange{{Field: "isActive", Before: true, After: false}}}}
		e.plan.ID, e.plan.ExpectedUpdatedAt = &c.ID, c.UpdatedAt
		before := *c
		before.Variants = nil
		e.plan.BeforeProduct = &before
		p.entries = append(p.entries, e)
		p.counts.Products.Deactivate++
	}
}

// planAddons resolves each row's add-on references, by variant SKU (or
// model number and variant name), ignoring case and repeated white space:
// first among the file's variants, then in the catalog. Unresolved
// references are warnings (D128).
func (p *planner) planAddons() {
	if len(p.idx.addons) == 0 {
		return
	}
	// A key that two variants have (an SKU equal to another variant's
	// model number and name, say) resolves to the first, with a warning.
	ambiguous := map[string]bool{}
	inFile := map[string]*entry{}
	for _, e := range p.entries {
		for _, k := range e.matchKeys {
			if other, taken := inFile[k]; !taken {
				inFile[k] = e
			} else if other != e {
				ambiguous[k] = true
			}
		}
	}
	type catalogRef struct {
		id    uuid.UUID
		label string
	}
	inCatalog := map[string]catalogRef{}
	labels := map[uuid.UUID]string{}
	for _, c := range p.catalog {
		for _, v := range c.Variants {
			label := variantLabel(c.ModelNumber, v.SKU, v.Name)
			labels[v.ID] = label
			for _, k := range catalogKeys(c.ModelNumber, v) {
				if other, taken := inCatalog[k]; !taken {
					inCatalog[k] = catalogRef{v.ID, label}
				} else if other.id != v.ID {
					ambiguous["catalog:"+k] = true
				}
			}
		}
	}
	for _, e := range p.entries {
		if e.item.Entity != "variant" || e.row == nil || e.item.Skipped {
			continue
		}
		list := []planAddon{}
		seen := map[string]bool{}
		for _, f := range p.idx.addons {
			ref := products.CollapseSpace(p.cell(e.row.row, f))
			if ref == "" {
				continue
			}
			required := p.targets[f].kind == tAddonRequired
			var a planAddon
			key := products.MatchKey(ref)
			p.scope.RefKeys = append(p.scope.RefKeys, key)
			_, inFileKey := inFile[key]
			if ambiguous[key] || (!inFileKey && ambiguous["catalog:"+key]) {
				p.issue("warning", e.row, f, "import.addon_ambiguous", map[string]any{"ref": ref})
			}
			if target := inFile[key]; target != nil {
				switch {
				case target == e:
					p.issue("warning", e.row, f, "addon.self", nil)
					continue
				case target.item.Skipped && target.item.ID == nil:
					p.issue("warning", e.row, f, "import.addon_skipped", map[string]any{"ref": ref})
					p.counts.Addons.Unresolved++
					continue
				}
				a = planAddon{VariantID: target.item.ID, Required: required, Label: variantLabel(target.item.ModelNumber, target.item.SKU, target.item.Name)}
				if target.item.ID == nil {
					a.Seq = target.item.Seq
				}
			} else if c, ok := inCatalog[key]; ok {
				if e.item.ID != nil && *e.item.ID == c.id {
					p.issue("warning", e.row, f, "addon.self", nil)
					continue
				}
				id := c.id
				a = planAddon{VariantID: &id, Required: required, Label: c.label}
			} else {
				p.issue("warning", e.row, f, "import.addon_not_found", map[string]any{"ref": ref})
				p.counts.Addons.Unresolved++
				continue
			}
			if seen[a.identity()] {
				p.issue("warning", e.row, f, "addon.duplicate", nil)
				continue
			}
			seen[a.identity()] = true
			list = append(list, a)
		}
		if len(list) > products.MaxAddons {
			p.issue("error", e.row, p.idx.addons[0], "validation.too_many", map[string]any{"max": products.MaxAddons})
			e.item.Skipped = true
			continue
		}
		var before []planAddon
		if e.existing != nil {
			for _, a := range e.existing.Addons {
				id := a.AddonVariantID
				before = append(before, planAddon{VariantID: &id, Required: a.Required, Label: labels[id]})
			}
		}
		if p.compareAddons(before, list) {
			continue
		}
		e.plan.Addons = &list
		e.item.Changes = append(e.item.Changes, ImportFieldChange{Field: "addons", Before: addonRefs(before), After: addonRefs(list)})
		if e.item.Status == "unchanged" {
			p.counts.Variants.Unchanged--
			p.counts.Variants.Changed++
			e.item.Status = "changed"
		}
	}
}

// catalogKeys are the keys an add-on reference finds a catalog variant by:
// its SKU, its model number and name, and for a "Standard" variant the
// model number alone (D128).
func catalogKeys(model string, v products.CatalogVariant) []string {
	keys := []string{products.MatchKey(model + " " + v.Name[i18n.DefaultLocale])}
	if sku := products.MatchKey(v.SKU); sku != "" {
		keys = append([]string{sku}, keys...)
	}
	if nameKey(v.Name[i18n.DefaultLocale]) == nameKey(StandardVariantName) {
		keys = append(keys, products.MatchKey(model))
	}
	return keys
}

// roundPrice rounds a decimal with more than two decimals to the cent, half
// up ("32.725" is "32.73"); ok is false when there is nothing to round.
func roundPrice(s string) (string, bool) {
	i := strings.IndexByte(s, '.')
	if i < 0 || len(s)-i-1 <= 2 || strings.HasPrefix(s, "-") {
		return s, false
	}
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		return s, false
	}
	return r.FloatString(2), true // halves away from zero: up for prices
}

func (a planAddon) identity() string {
	if a.VariantID != nil {
		return a.VariantID.String()
	}
	return "seq:" + strconv.Itoa(a.Seq)
}

// compareAddons counts the links and reports whether nothing changes.
func (p *planner) compareAddons(before, after []planAddon) bool {
	pos := map[string]int{}
	for i, a := range before {
		pos[a.identity()] = i
	}
	same := len(before) == len(after)
	kept := map[string]bool{}
	for i, a := range after {
		j, ok := pos[a.identity()]
		switch {
		case !ok:
			p.counts.Addons.New++
			same = false
		case before[j].Required != a.Required || j != i:
			p.counts.Addons.Changed++
			same = false
		default:
			p.counts.Addons.Unchanged++
		}
		kept[a.identity()] = true
	}
	for _, a := range before {
		if !kept[a.identity()] {
			p.counts.Addons.Removed++
			same = false
		}
	}
	return same
}

func addonRefs(list []planAddon) []ImportAddonRef {
	out := make([]ImportAddonRef, len(list))
	for i, a := range list {
		out[i] = ImportAddonRef{VariantID: a.VariantID, Label: a.Label, Required: a.Required}
	}
	return out
}

func variantLabel(model, sku string, name i18n.Text) string {
	if sku != "" {
		return sku
	}
	return model + " " + name["en"]
}

// countImages counts the variants whose image the import sets.
func (p *planner) countImages() {
	if p.idx.image < 0 {
		return
	}
	for _, e := range p.entries {
		if e.item.Entity != "variant" || e.plan.Variant == nil || e.plan.Variant.ImageFileID == nil || e.item.Skipped {
			continue
		}
		switch {
		case e.existing == nil || e.existing.ImageFileID == nil:
			p.counts.Images.New++
		case *e.existing.ImageFileID != *e.plan.Variant.ImageFileID:
			p.counts.Images.Changed++
		default:
			p.counts.Images.Unchanged++
		}
	}
}

func (p *planner) countItem(c *ImportCounter, status string) {
	switch status {
	case "new":
		c.New++
	case "changed":
		c.Changed++
	case "unchanged":
		c.Unchanged++
	case "deactivate":
		c.Deactivate++
	}
}

func status(exists bool, changes int) string {
	switch {
	case !exists:
		return "new"
	case changes > 0:
		return "changed"
	}
	return "unchanged"
}

// productChanges lists the fields that differ between the stored product
// (nil for a new one) and its state after the import, comparing normalised
// values (D122: re-importing the same file changes nothing).
func (p *planner) productChanges(before *products.CatalogProduct, after products.ProductInput, pt producttypes.ProductType, cat categories.Category, catSeq int) []ImportFieldChange {
	var b products.CatalogProduct
	if before != nil {
		b = *before
	}
	out := []ImportFieldChange{}
	add := func(field string, old, now any) {
		if !sameJSON(old, now) {
			out = append(out, ImportFieldChange{Field: field, Before: old, After: now})
		}
	}
	add("modelNumber", nilIfEmpty(b.ModelNumber), after.ModelNumber)
	if before == nil || before.ProductTypeID != after.ProductTypeID {
		var old any
		if before != nil {
			old = typeRef(p.typeByID[before.ProductTypeID])
		}
		out = append(out, ImportFieldChange{Field: "productType", Before: old, After: typeRef(pt)})
	}
	if before == nil || catSeq != 0 || before.CategoryID != after.CategoryID {
		var old any
		if before != nil {
			old = categoryRef(p.categoryByID[before.CategoryID], 0)
		}
		out = append(out, ImportFieldChange{Field: "category", Before: old, After: categoryRef(cat, catSeq)})
	}
	textChanges(add, "name", b.Name, after.Name)
	textChanges(add, "description", b.Description, after.Description)
	valueChanges(add, b.Attributes, after.Attributes)
	if before == nil || !before.IsActive {
		add("isActive", activeBefore(before != nil, b.IsActive), true)
	}
	return out
}

func variantChanges(before *products.CatalogVariant, after products.VariantInput) []ImportFieldChange {
	var b products.CatalogVariant
	if before != nil {
		b = *before
	}
	out := []ImportFieldChange{}
	add := func(field string, old, now any) {
		if !sameJSON(old, now) {
			out = append(out, ImportFieldChange{Field: field, Before: old, After: now})
		}
	}
	textChanges(add, "name", b.Name, after.Name)
	add("sku", nilIfEmpty(b.SKU), nilIfEmpty(after.SKU))
	add("price", nilIfEmpty(b.Price), after.Price)
	add("image", b.ImageFileID, after.ImageFileID)
	valueChanges(add, b.Attributes, after.Attributes)
	if before == nil || !before.IsActive {
		add("isActive", activeBefore(before != nil, b.IsActive), true)
	}
	return out
}

func activeBefore(exists, active bool) any {
	if !exists {
		return nil
	}
	return active
}

func textChanges(add func(string, any, any), field string, before, after i18n.Text) {
	for _, l := range i18n.Locales {
		add(field+"."+l, nilIfEmpty(before[l]), nilIfEmpty(after[l]))
	}
}

func valueChanges(add func(string, any, any), before, after attrschema.Values) {
	keys := []string{}
	for k := range before {
		keys = append(keys, k)
	}
	for k := range after {
		if _, ok := before[k]; !ok {
			keys = append(keys, k)
		}
	}
	slices.Sort(keys)
	for _, k := range keys {
		add("attributes."+k, before[k], after[k])
	}
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// sameJSON compares values as JSON, so an integer read back from jsonb
// (float64 4) equals a normalised one (int64 4).
func sameJSON(a, b any) bool {
	x, err1 := json.Marshal(a)
	y, err2 := json.Marshal(b)
	return err1 == nil && err2 == nil && string(x) == string(y)
}

func nameKey(name string) string { return strings.ToLower(products.CollapseSpace(name)) }

func setText(t i18n.Text, locale, value string) {
	if v := strings.TrimSpace(value); v != "" {
		t[locale] = v
	} else {
		delete(t, locale)
	}
}

func cloneText(t i18n.Text) i18n.Text {
	out := i18n.Text{}
	for k, v := range t {
		out[k] = v
	}
	return out
}

func cloneValues(v attrschema.Values) attrschema.Values {
	out := attrschema.Values{}
	for k, x := range v {
		out[k] = x
	}
	return out
}
