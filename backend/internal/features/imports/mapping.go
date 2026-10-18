package imports

import (
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/categories"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
	"github.com/kingkill85/snapflow/backend/internal/platform/importsrc"
)

// Limits of profiles.
const (
	MaxProfileNameLength = 100
	MaxFields            = 200
	maxRowNumber         = 1_000_000
)

// StarterProfileName is the profile created when none exists (D134).
const StarterProfileName = "SnapFlow 1 workbook"

// StarterProductType is the key of the product type (system) the starter
// profile puts every row on: SnapFlow 1 sold Zigbee devices only.
const StarterProductType = "zigbee"

// StarterMapping maps SnapFlow 1's catalog workbook (inventory 01 G,
// workbook-sample): header row 3, data from row 4, Category as category
// (missing ones created), the product type with key "zigbee" as a constant
// (it must exist: the import never creates product types), Dimensions as a
// text attribute, "Model Number + Style" as SKU, price in USD, add-ons
// 01-03 required and 04-08 optional, the pictures floating over each row.
func StarterMapping() ImportMapping {
	col := func(target, header, letter string) ImportField {
		return ImportField{Target: target, Column: header, ColumnLetter: letter}
	}
	zigbee := StarterProductType
	m := ImportMapping{
		SourceKind: "xlsx", HeaderRow: 3, DataStartRow: 4, CreateMissingCategories: true, AllOrNothing: true,
		Fields: []ImportField{
			{Target: "product.productType", Value: &zigbee},
			col("product.category", "Category", "B"),
			col("product.name.en", "Item Name", "E"),
			col("product.description.en", "Item Description", "F"),
			col("product.modelNumber", "Model Number", "G"),
			col("attribute.dimensions", "Dimensions (mm)", "H"),
			{Target: "variant.image"},
			col("variant.name.en", "Style", "I"),
			col("variant.sku", "Model Number + Style", "J"),
			col("variant.price", "Price (USD)", "K"),
		},
	}
	for i, letter := range []string{"M", "N", "O"} {
		m.Fields = append(m.Fields, col("addon.required", fmt.Sprintf("Mandatory Addon - %02d", i+1), letter))
	}
	for i, letter := range []string{"Q", "R", "S", "T", "U"} {
		m.Fields = append(m.Fields, col("addon.optional", fmt.Sprintf("Optional Addon - %02d", i+4), letter))
	}
	return m
}

// targetKind is what a mapping target feeds.
type targetKind int

const (
	tModelNumber targetKind = iota + 1
	tProductName
	tProductDescription
	tProductType
	tCategory
	tVariantName
	tVariantSKU
	tVariantPrice
	tVariantImage
	tAddonRequired
	tAddonOptional
	tAttribute
)

type target struct {
	kind   targetKind
	locale string // names and descriptions
	key    string // attributes
}

var attributeKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

func parseTarget(s string) (target, bool) {
	fixed := map[string]targetKind{
		"product.modelNumber": tModelNumber, "product.productType": tProductType, "product.category": tCategory,
		"variant.sku": tVariantSKU, "variant.price": tVariantPrice, "variant.image": tVariantImage,
		"addon.required": tAddonRequired, "addon.optional": tAddonOptional,
	}
	if k, ok := fixed[s]; ok {
		return target{kind: k}, true
	}
	for prefix, k := range map[string]targetKind{"product.name.": tProductName, "product.description.": tProductDescription, "variant.name.": tVariantName} {
		if locale, ok := strings.CutPrefix(s, prefix); ok {
			return target{kind: k, locale: locale}, slices.Contains(i18n.Locales, locale)
		}
	}
	if key, ok := strings.CutPrefix(s, "attribute."); ok {
		return target{kind: tAttribute, key: key}, len(key) <= 64 && attributeKeyPattern.MatchString(key)
	}
	return target{}, false
}

func (t target) repeatable() bool { return t.kind == tAddonRequired || t.kind == tAddonOptional }

func (t target) constantAllowed() bool {
	switch t.kind {
	case tProductType, tCategory, tProductName, tProductDescription, tVariantName, tVariantPrice, tAttribute:
		return true
	}
	return false
}

// validateMapping checks a mapping and returns it normalised (texts
// trimmed, letters upper case). Every problem is reported at its location
// (loc is e.g. "body.mapping").
func validateMapping(m ImportMapping, types map[uuid.UUID]producttypes.ProductType, cats map[uuid.UUID]categories.Category, loc string) (ImportMapping, []apperr.FieldError) {
	errs := []apperr.FieldError{}
	if m.SourceKind != string(importsrc.KindXLSX) && m.SourceKind != string(importsrc.KindCSV) {
		errs = append(errs, apperr.Field(loc+".sourceKind", "validation.invalid", "sourceKind must be xlsx or csv"))
	}
	m.Sheet = strings.TrimSpace(m.Sheet)
	if utf8.RuneCountInString(m.Sheet) > 100 {
		errs = append(errs, apperr.Field(loc+".sheet", "validation.too_long", "sheet name too long").With("max", 100))
	}
	if m.HeaderRow < 0 || m.HeaderRow > maxRowNumber {
		errs = append(errs, apperr.Field(loc+".headerRow", "validation.invalid", "invalid header row"))
	}
	if m.DataStartRow < 1 || m.DataStartRow > maxRowNumber || m.DataStartRow <= m.HeaderRow {
		errs = append(errs, apperr.Field(loc+".dataStartRow", "import_profile.data_start_row", "the data must start below the header row"))
	}
	if m.ProductTypeID != nil {
		if _, ok := types[*m.ProductTypeID]; !ok {
			errs = append(errs, apperr.Field(loc+".productTypeId", "product.type_not_found", "no such product type"))
		}
	}
	if m.CategoryID != nil {
		if _, ok := cats[*m.CategoryID]; !ok {
			errs = append(errs, apperr.Field(loc+".categoryId", "product.category_not_found", "no such category"))
		}
	}
	if len(m.Fields) > MaxFields {
		return m, append(errs, apperr.Field(loc+".fields", "validation.too_many", "too many fields").With("max", MaxFields))
	}
	seen := map[string]bool{}
	hasModel, hasType, hasCategory := false, false, false
	fields := make([]ImportField, len(m.Fields))
	for i, f := range m.Fields {
		floc := fmt.Sprintf("%s.fields[%d]", loc, i)
		f.Target = strings.TrimSpace(f.Target)
		f.Column = strings.TrimSpace(f.Column)
		f.ColumnLetter = strings.ToUpper(strings.TrimSpace(f.ColumnLetter))
		fields[i] = f
		t, ok := parseTarget(f.Target)
		if !ok {
			errs = append(errs, apperr.Field(floc+".target", "import_profile.target_unknown", "unknown target"))
			continue
		}
		if seen[f.Target] && !t.repeatable() {
			errs = append(errs, apperr.Field(floc+".target", "import_profile.target_duplicate", "this target is mapped twice"))
		}
		seen[f.Target] = true
		hasModel = hasModel || t.kind == tModelNumber
		hasType = hasType || t.kind == tProductType
		hasCategory = hasCategory || t.kind == tCategory
		if f.ColumnLetter != "" {
			if _, ok := importsrc.ColumnIndex(f.ColumnLetter); !ok {
				errs = append(errs, apperr.Field(floc+".columnLetter", "import_profile.column_letter", "not a column letter"))
			}
		}
		hasColumn := f.Column != "" || f.ColumnLetter != ""
		switch {
		case f.Value != nil && hasColumn:
			errs = append(errs, apperr.Field(floc, "import_profile.source_conflict", "a column or a constant, not both"))
		case f.Value != nil && !t.constantAllowed():
			errs = append(errs, apperr.Field(floc+".value", "import_profile.constant_not_allowed", "this target cannot take a constant"))
		case f.Value == nil && !hasColumn && t.kind != tVariantImage:
			errs = append(errs, apperr.Field(floc, "import_profile.source_required", "map a column or a constant"))
		}
	}
	m.Fields = fields
	if !hasModel {
		errs = append(errs, apperr.Field(loc+".fields", "import_profile.model_number_required", "map the model number"))
	}
	switch {
	case hasType && m.ProductTypeID != nil:
		errs = append(errs, apperr.Field(loc+".productTypeId", "import_profile.product_type_conflict", "a fixed product type or a column, not both"))
	case !hasType && m.ProductTypeID == nil:
		errs = append(errs, apperr.Field(loc+".fields", "import_profile.product_type_required", "map the product type or choose a fixed one"))
	}
	switch {
	case hasCategory && m.CategoryID != nil:
		errs = append(errs, apperr.Field(loc+".categoryId", "import_profile.category_conflict", "a fixed category or a column, not both"))
	case !hasCategory && m.CategoryID == nil:
		errs = append(errs, apperr.Field(loc+".fields", "import_profile.category_required", "map the category or choose a fixed one"))
	}
	return m, errs
}

// column is where a mapped field reads from.
type column struct {
	index    int    // absolute column, -1 for a constant or "any column"
	value    string // the constant
	constant bool
}

// resolveColumns finds each field's column: by header text in the header
// row (ignoring case and repeated white space; the first match), else by
// letter. A field whose header is missing and has no letter fails with
// import.column_missing at loc.fields[i].
func resolveColumns(m ImportMapping, header importsrc.Row, loc string) ([]column, []apperr.FieldError) {
	out := make([]column, len(m.Fields))
	errs := []apperr.FieldError{}
	for i, f := range m.Fields {
		switch {
		case f.Value != nil:
			out[i] = column{index: -1, value: *f.Value, constant: true}
			continue
		case f.Column == "" && f.ColumnLetter == "":
			out[i] = column{index: -1}
			continue
		}
		out[i].index = -1
		if f.Column != "" {
			want := headerKey(f.Column)
			for col, cell := range header.Cells {
				if headerKey(cell) == want {
					out[i].index = col
					break
				}
			}
		}
		if out[i].index < 0 && f.ColumnLetter != "" {
			out[i].index, _ = importsrc.ColumnIndex(f.ColumnLetter)
		}
		if out[i].index < 0 {
			errs = append(errs, apperr.Field(fmt.Sprintf("%s.fields[%d].column", loc, i), "import.column_missing",
				"the file has no such column").With("column", f.Column))
		}
	}
	return out, errs
}

func headerKey(s string) string { return strings.ToLower(products.CollapseSpace(s)) }

// targets lists what columns can be mapped to: the fixed targets, then
// every attribute key of the given categories (all when none are given).
func targets(cats []categories.Category, only map[uuid.UUID]bool) []ImportTarget {
	out := []ImportTarget{{Target: "product.modelNumber", Group: "product", Required: true}}
	for _, l := range i18n.Locales {
		out = append(out, ImportTarget{Target: "product.name." + l, Group: "product", Constant: true})
	}
	for _, l := range i18n.Locales {
		out = append(out, ImportTarget{Target: "product.description." + l, Group: "product", Constant: true})
	}
	out = append(out,
		ImportTarget{Target: "product.productType", Group: "product", Constant: true, Required: true},
		ImportTarget{Target: "product.category", Group: "product", Constant: true, Required: true},
	)
	for _, l := range i18n.Locales {
		out = append(out, ImportTarget{Target: "variant.name." + l, Group: "variant", Constant: true})
	}
	out = append(out,
		ImportTarget{Target: "variant.sku", Group: "variant"},
		ImportTarget{Target: "variant.price", Group: "variant", Constant: true},
		ImportTarget{Target: "variant.image", Group: "variant", ColumnOptional: true},
		ImportTarget{Target: "addon.required", Group: "addon", Repeatable: true},
		ImportTarget{Target: "addon.optional", Group: "addon", Repeatable: true},
	)
	byKey := map[string]*ImportAttributeTarget{}
	keys := []string{}
	for _, c := range cats {
		if len(only) > 0 && !only[c.ID] {
			continue
		}
		for _, a := range c.Attributes {
			at, ok := byKey[a.Key]
			if !ok {
				at = &ImportAttributeTarget{Key: a.Key, Label: a.Label}
				byKey[a.Key] = at
				keys = append(keys, a.Key)
			}
			at.Categories = append(at.Categories, ImportAttributeOfCategory{CategoryID: c.ID, Definition: a})
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		out = append(out, ImportTarget{Target: "attribute." + k, Group: "attribute", Constant: true, Attribute: byKey[k]})
	}
	return out
}
