package imports

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"unicode"

	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/categories"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

// checkColumns matches every attribute column of a (validated) mapping
// against the catalog fields (D188) and returns the mapping with the links
// set: a column answered as information stays so; a column linked to an
// existing field keeps it; otherwise the attribute key, then the header
// text are compared with each field's key and labels, ignoring case,
// spacing and punctuation. A column no field matches is known ("category":
// known, no meaning) when an existing category defines the attribute key
// (with a fixed mapping.categoryId only that category counts), else
// unknown. Each column lists the considered categories that define its key
// with the link status (linked, will_link, type_mismatch, other_field,
// unlinked).
func checkColumns(m ImportMapping, fields map[string]capabilities.CatalogField, cats []categories.Category) (ImportMapping, []ImportColumn) {
	byName := map[string]string{}
	keys := make([]string, 0, len(fields))
	for k := range fields {
		keys = append(keys, k)
	}
	// Keys first (a key beats another field's label), then labels; the
	// first field in key order wins.
	slices.Sort(keys)
	for _, k := range keys {
		if n := fieldName(k); n != "" {
			if _, taken := byName[n]; !taken {
				byName[n] = k
			}
		}
	}
	for _, k := range keys {
		for _, l := range fields[k].Label {
			if n := fieldName(l); n != "" {
				if _, taken := byName[n]; !taken {
					byName[n] = k
				}
			}
		}
	}
	considered := cats
	if m.CategoryID != nil {
		considered = nil
		for _, c := range cats {
			if c.ID == *m.CategoryID {
				considered = append(considered, c)
			}
		}
	}
	out := []ImportColumn{}
	m.Fields = append([]ImportField(nil), m.Fields...)
	for i, f := range m.Fields {
		t, ok := parseTarget(f.Target)
		if !ok || t.kind != tAttribute {
			continue
		}
		col := ImportColumn{FieldIndex: i, Target: f.Target, Key: t.key, Column: f.Column, ColumnLetter: f.ColumnLetter,
			Categories: []ImportColumnCategory{}}
		if _, ok := fields[f.FieldKey]; !ok {
			f.FieldKey = ""
		}
		if f.FieldKey == "" && !f.Information {
			for _, name := range []string{t.key, f.Column} {
				if k, ok := byName[fieldName(name)]; ok && name != "" {
					f.FieldKey = k
					break
				}
			}
		}
		if f.Information {
			f.FieldKey = ""
		}
		var field *capabilities.CatalogField
		if f.FieldKey != "" {
			fl := fields[f.FieldKey]
			field = &fl
		}
		for _, c := range considered {
			for _, a := range c.Attributes {
				if a.Key != t.key {
					continue
				}
				cc := ImportColumnCategory{CategoryID: c.ID, Key: c.Key, Name: c.Name, AttributeType: string(a.Type), FieldKey: a.FieldKey}
				switch {
				case field != nil && a.FieldKey == field.Key:
					cc.Status = ColumnCategoryLinked
				case a.FieldKey != "":
					cc.Status = ColumnCategoryOtherField
				case field == nil:
					cc.Status = ColumnCategoryUnlinked
				case a.Type == field.Type:
					cc.Status = ColumnCategoryWillLink
				default:
					cc.Status = ColumnCategoryTypeMismatch
				}
				col.Categories = append(col.Categories, cc)
			}
		}
		switch {
		case f.Information:
			col.Status = ColumnInformation
		case field != nil:
			col.Status, col.Field = ColumnField, field
		case len(col.Categories) > 0:
			col.Status = ColumnCategory
		default:
			col.Status = ColumnUnknown
		}
		m.Fields[i] = f
		out = append(out, col)
	}
	return m, out
}

// fieldName is a name compared ignoring case, spacing and punctuation:
// "Bus current (mA)" and "bus_current_ma" are the same.
func fieldName(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func countUnknown(cols []ImportColumn) (int, []string) {
	n, targets := 0, []string{}
	for _, c := range cols {
		if c.Status == ColumnUnknown {
			n++
			targets = append(targets, c.Target)
		}
	}
	return n, targets
}

// errColumnsUnknown blocks a preview until the unknown columns are answered.
func errColumnsUnknown(targets []string) error {
	return apperr.New(422, "import.columns_unknown", "some columns are unknown: answer what they mean first").
		With("count", len(targets)).With("columns", strings.Join(targets, ", "))
}

// Columns checks a mapping's attribute columns against the catalog fields
// (D188) and returns the mapping with matched columns linked.
func (s *Service) Columns(ctx context.Context, in ImportColumnsInput) (ImportColumns, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return ImportColumns{}, err
	}
	types, cats, err := s.refs(ctx)
	if err != nil {
		return ImportColumns{}, err
	}
	mapping, errs := validateMapping(in.Mapping, typesByID(types), categoriesByID(cats), "body.mapping")
	if len(errs) > 0 {
		return ImportColumns{}, apperr.Validation(errs...)
	}
	fields, err := s.caps.FieldsByKey(ctx)
	if err != nil {
		return ImportColumns{}, err
	}
	mapping, cols := checkColumns(mapping, fields, cats)
	n, _ := countUnknown(cols)
	return ImportColumns{Mapping: mapping, Columns: cols, Unknown: n}, nil
}

// AnswerColumns answers attribute columns: each answer creates a catalog
// field (in one transaction, all or none) and links the column to it,
// links it to an existing field (fieldKey), or marks the column as just
// information. Any attribute column may be answered, also one the check
// matched automatically (overriding a fuzzy match). Returns the column check of the
// answered mapping; the client previews with it (and saves it in the
// profile to keep the answers).
func (s *Service) AnswerColumns(ctx context.Context, in ImportColumnAnswers) (ImportColumns, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return ImportColumns{}, err
	}
	types, cats, err := s.refs(ctx)
	if err != nil {
		return ImportColumns{}, err
	}
	mapping, errs := validateMapping(in.Mapping, typesByID(types), categoriesByID(cats), "body.mapping")
	if len(errs) > 0 {
		return ImportColumns{}, apperr.Validation(errs...)
	}
	index := map[string]int{}
	for i, f := range mapping.Fields {
		if t, ok := parseTarget(f.Target); ok && t.kind == tAttribute {
			index[f.Target] = i
		}
	}
	var (
		fields   map[string]capabilities.CatalogField
		creates  []capabilities.CatalogFieldInput
		createAt []int // answer index of each create
		answered = map[string]bool{}
	)
	for i, a := range in.Answers {
		loc := fmt.Sprintf("body.answers[%d]", i)
		fi, ok := index[a.Target]
		switch {
		case !ok:
			errs = append(errs, apperr.Field(loc+".target", "import.answer_target", "no attribute column with this target"))
			continue
		case answered[a.Target]:
			errs = append(errs, apperr.Field(loc+".target", "import_profile.target_duplicate", "answered twice"))
			continue
		}
		kinds := 0
		for _, set := range []bool{a.Information, a.Field != nil, strings.TrimSpace(a.FieldKey) != ""} {
			if set {
				kinds++
			}
		}
		if kinds != 1 {
			errs = append(errs, apperr.Field(loc, "import.answer_required", "choose a new field, an existing field or just information"))
			continue
		}
		answered[a.Target] = true
		if a.Information {
			mapping.Fields[fi].Information, mapping.Fields[fi].FieldKey = true, ""
			continue
		}
		if key := strings.TrimSpace(a.FieldKey); key != "" {
			if fields == nil {
				if fields, err = s.caps.FieldsByKey(ctx); err != nil {
					return ImportColumns{}, err
				}
			}
			if _, ok := fields[key]; !ok {
				errs = append(errs, apperr.Field(loc+".fieldKey", "import.answer_field_not_found", "no such catalog field").With("key", key))
				continue
			}
			mapping.Fields[fi].FieldKey, mapping.Fields[fi].Information = key, false
			continue
		}
		creates = append(creates, *a.Field)
		createAt = append(createAt, i)
	}
	if len(errs) > 0 {
		return ImportColumns{}, apperr.Validation(errs...)
	}
	if len(creates) > 0 {
		created, err := s.caps.CreateFields(ctx, creates, func(j int) string { return fmt.Sprintf("body.answers[%d].field", createAt[j]) })
		if err != nil {
			return ImportColumns{}, err
		}
		for j, f := range created {
			fi := index[in.Answers[createAt[j]].Target]
			mapping.Fields[fi].FieldKey, mapping.Fields[fi].Information = f.Key, false
		}
	}
	fields, err = s.caps.FieldsByKey(ctx)
	if err != nil {
		return ImportColumns{}, err
	}
	mapping, cols := checkColumns(mapping, fields, cats)
	n, _ := countUnknown(cols)
	return ImportColumns{Mapping: mapping, Columns: cols, Unknown: n}, nil
}

// mountingValue reads a mounting cell: the key or a usual English or German
// word for it, ignoring case and spacing; "" for a blank cell, false for
// anything else.
func mountingValue(cell string) (string, bool) {
	switch fieldName(cell) {
	case "":
		return "", true
	case "floorplan", "floor", "grundriss", "plan", "room", "raum":
		return string(capabilities.MountingFloorplan), true
	case "board", "distributionboard", "verteiler", "verteilung", "din", "dinrail", "hutschiene", "unterverteilung":
		return string(capabilities.MountingBoard), true
	case "both", "beide", "beides":
		return string(capabilities.MountingBoth), true
	}
	return "", false
}

// ProfilesLinkingField counts the import profiles whose mapping links an
// attribute column to the catalog field key (capabilities refuses changing
// such a key: catalog_field.key_referenced). With tx it reads in tx.
func (s *Service) ProfilesLinkingField(ctx context.Context, tx pgx.Tx, key string) (int, error) {
	q := s.q
	if tx != nil {
		q = q.WithTx(tx)
	}
	n, err := q.ProfilesLinkingField(ctx, key)
	return int(n), err
}
