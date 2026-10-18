package imports

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/features/categories"
	"github.com/kingkill85/snapflow/backend/internal/features/products"
	"github.com/kingkill85/snapflow/backend/internal/features/producttypes"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// catalogScope describes what part of the catalog a preview read (stored
// with the run as catalog_scope). scopeToken hashes exactly that part, so an
// edit elsewhere (another system, another category) does not make the
// preview stale (D147).
type catalogScope struct {
	// Pairs are the product type and category pairs of the import's scope
	// (D123): their products may be deactivated.
	Pairs [][2]uuid.UUID `json:"pairs"`
	// ModelKeys are the MatchKeys of the file's model numbers (also of
	// skipped products).
	ModelKeys []string `json:"modelKeys"`
	// SKUKeys are the MatchKeys of every SKU in the file.
	SKUKeys []string `json:"skuKeys"`
	// RefKeys are the MatchKeys of every add-on reference of the rows
	// without errors, resolved or not.
	RefKeys []string `json:"refKeys"`
	// CategoryValues and TypeValues are the category and product type
	// values the rows (or constants) name.
	CategoryValues []string `json:"categoryValues"`
	TypeValues     []string `json:"typeValues"`
	// TypeIDs and CategoryIDs are the product types and categories the
	// preview used (fixed, constant or resolved per row).
	TypeIDs     []uuid.UUID `json:"typeIds"`
	CategoryIDs []uuid.UUID `json:"categoryIds"`
}

// normalize sorts and deduplicates every list, so equal scopes are equal
// JSON.
func (s *catalogScope) normalize() {
	for _, list := range []*[]string{&s.ModelKeys, &s.SKUKeys, &s.RefKeys, &s.CategoryValues, &s.TypeValues} {
		if *list == nil {
			*list = []string{}
		}
		slices.Sort(*list)
		*list = slices.Compact(*list)
	}
	byString := func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) }
	for _, list := range []*[]uuid.UUID{&s.TypeIDs, &s.CategoryIDs} {
		if *list == nil {
			*list = []uuid.UUID{}
		}
		slices.SortFunc(*list, byString)
		*list = slices.Compact(*list)
	}
	if s.Pairs == nil {
		s.Pairs = [][2]uuid.UUID{}
	}
	slices.SortFunc(s.Pairs, func(a, b [2]uuid.UUID) int {
		if c := byString(a[0], b[0]); c != 0 {
			return c
		}
		return byString(a[1], b[1])
	})
	s.Pairs = slices.Compact(s.Pairs)
}

// scopeToken identifies the state of the part of the catalog a preview
// read (D147). Preview and apply both call it, on the catalog they read, so
// matching has the same semantics on both sides. It covers:
//   - the product types the preview used and those whose key, English name
//     or abbreviation matches a type value (resolution depends on exactly
//     these: a type created or renamed to match a value joins the set), and
//     the types of the products in scope or matched (the diff shows them);
//   - the categories the preview used, those whose key, derived key or
//     English name matches a category value (also one created since that
//     the run would create too), and the categories of the products in
//     scope or matched (the diff shows them);
//   - the products in a scope pair or whose model number is in the file,
//     in any state (membership counts: a product moved into the scope or
//     created with a file's model number changes the token);
//   - the variants of the products the file matched, with their add-on
//     lists and the lists' versions;
//   - the variants owning one of the file's SKUs, with their product;
//   - the variants an add-on reference finds (by SKU, model number and name,
//     or the model number of a "Standard" variant) and their products
//     (their model number labels the link).
//
// Other systems and categories and the add-on lists of unrelated variants
// are not covered.
func scopeToken(types []producttypes.ProductType, cats []categories.Category, catalog []products.CatalogProduct, sc catalogScope) (string, error) {
	type version struct {
		ID        uuid.UUID `json:"i"`
		UpdatedAt time.Time `json:"u"`
	}
	type variant struct {
		version
		ProductID       uuid.UUID             `json:"p"`
		AddonsUpdatedAt *time.Time            `json:"au,omitempty"`
		Addons          []products.AddonInput `json:"a,omitempty"`
	}
	in := func(list []string) map[string]bool {
		m := make(map[string]bool, len(list))
		for _, k := range list {
			m[k] = true
		}
		return m
	}
	modelKeys, skuKeys, refKeys := in(sc.ModelKeys), in(sc.SKUKeys), in(sc.RefKeys)
	pairs := make(map[[2]uuid.UUID]bool, len(sc.Pairs))
	for _, p := range sc.Pairs {
		pairs[p] = true
	}
	catIDs, typeIDs := map[uuid.UUID]bool{}, map[uuid.UUID]bool{}
	for _, id := range sc.CategoryIDs {
		catIDs[id] = true
	}
	for _, id := range sc.TypeIDs {
		typeIDs[id] = true
	}

	state := struct {
		Types      []version `json:"t"`
		Categories []version `json:"c"`
		Products   []version `json:"p"`
		Variants   []variant `json:"v"`
	}{Types: []version{}, Categories: []version{}, Products: []version{}, Variants: []variant{}}

	productSeen := map[uuid.UUID]bool{}
	addProduct := func(p *products.CatalogProduct) {
		if !productSeen[p.ID] {
			productSeen[p.ID] = true
			state.Products = append(state.Products, version{p.ID, p.UpdatedAt})
		}
	}
	variantSeen := map[uuid.UUID]bool{}
	addVariant := func(v *products.CatalogVariant, withAddons bool) {
		if variantSeen[v.ID] {
			return
		}
		variantSeen[v.ID] = true
		out := variant{version: version{v.ID, v.UpdatedAt}, ProductID: v.ProductID}
		if withAddons {
			at := v.AddonsUpdatedAt
			out.AddonsUpdatedAt, out.Addons = &at, v.Addons
		}
		state.Variants = append(state.Variants, out)
	}
	for i := range catalog {
		p := &catalog[i]
		matched := modelKeys[products.MatchKey(p.ModelNumber)]
		if matched || pairs[[2]uuid.UUID{p.ProductTypeID, p.CategoryID}] {
			addProduct(p)
			catIDs[p.CategoryID] = true // the diff shows them
			typeIDs[p.ProductTypeID] = true
		}
		if matched {
			for j := range p.Variants {
				addVariant(&p.Variants[j], true)
			}
		}
	}
	// SKU owners and add-on targets (after the matched products, whose
	// variants carry their add-on lists).
	for i := range catalog {
		p := &catalog[i]
		for j := range p.Variants {
			v := &p.Variants[j]
			if v.SKU != "" && skuKeys[products.MatchKey(v.SKU)] {
				addVariant(v, false)
				addProduct(p)
			}
			if len(refKeys) == 0 {
				continue
			}
			for _, k := range catalogKeys(p.ModelNumber, *v) {
				if refKeys[k] {
					addVariant(v, false)
					addProduct(p)
					break
				}
			}
		}
	}

	typeValues := make(map[string]bool, len(sc.TypeValues))
	for _, v := range sc.TypeValues {
		typeValues[matchKey(v)] = true
	}
	for _, t := range types {
		if typeIDs[t.ID] || typeValues[strings.ToLower(t.Key)] || typeValues[matchKey(t.Name[i18n.DefaultLocale])] ||
			(t.Abbreviation != "" && typeValues[matchKey(t.Abbreviation)]) {
			state.Types = append(state.Types, version{t.ID, t.UpdatedAt})
		}
	}
	values := make([][2]string, 0, len(sc.CategoryValues))
	for _, v := range sc.CategoryValues {
		values = append(values, [2]string{matchKey(v), categoryKey(v)})
	}
	for _, c := range cats {
		match := catIDs[c.ID]
		for _, v := range values {
			match = match || c.Key == v[0] || c.Key == v[1] || matchKey(c.Name[i18n.DefaultLocale]) == v[0]
		}
		if match {
			state.Categories = append(state.Categories, version{c.ID, c.UpdatedAt})
		}
	}

	byID := func(list []version) {
		sort.Slice(list, func(i, j int) bool { return list[i].ID.String() < list[j].ID.String() })
	}
	byID(state.Types)
	byID(state.Categories)
	byID(state.Products)
	sort.Slice(state.Variants, func(i, j int) bool { return state.Variants[i].ID.String() < state.Variants[j].ID.String() })
	data, err := json.Marshal(struct {
		Scope catalogScope `json:"s"`
		State any          `json:"c"`
	}{sc, state})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}
