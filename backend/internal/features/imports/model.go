package imports

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/platform/attrschema"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// ImportMapping says how a file's rows become products and variants: which sheet
// and rows to read and which column (or constant) feeds which target.
type ImportMapping struct {
	SourceKind string `json:"sourceKind" enum:"xlsx,csv" doc:"The file format the profile is made for (informational: any file can be previewed with it)"`
	Sheet      string `json:"sheet,omitempty" maxLength:"100" doc:"Sheet name; empty for the first sheet"`
	HeaderRow  int    `json:"headerRow" doc:"Row number of the column headers (1 first); 0 for a file without a header row (columns by letter only)"`
	// DataStartRow is the first row read as data.
	DataStartRow int `json:"dataStartRow" doc:"First data row (1 first), after the header row"`
	// ProductTypeID gives every row this product type (system), instead of
	// a product.productType column or constant.
	ProductTypeID *uuid.UUID `json:"productTypeId,omitempty" doc:"Fixed product type (system) of every row, instead of a product.productType column or constant"`
	// CategoryID gives every row this category, instead of a
	// product.category column or constant.
	CategoryID *uuid.UUID `json:"categoryId,omitempty" doc:"Fixed category of every row, instead of a product.category column or constant"`
	// CreateMissingCategories creates categories that the file names but
	// the catalog lacks (a text attribute per mapped attribute key),
	// instead of reporting the rows. Product types are never created.
	CreateMissingCategories bool `json:"createMissingCategories" required:"false" doc:"Create categories the file names but the catalog lacks (default off: unknown categories are row errors). Product types are never created"`
	// AllOrNothing refuses to apply a preview with row errors; off, rows
	// with errors are skipped. The apply request can override it.
	AllOrNothing bool          `json:"allOrNothing" required:"false" doc:"Apply nothing while any row has errors (default on when left out); off skips rows with errors"`
	Fields       []ImportField `json:"fields" maxItems:"1000" doc:"Column or constant per target (at most 200)"`
}

// UnmarshalJSON turns "all or nothing" on when it is left out. (A huma
// default would also turn an explicit false on: it fills zero values.)
func (m *ImportMapping) UnmarshalJSON(data []byte) error {
	type plain ImportMapping
	p := plain{AllOrNothing: true}
	if err := json.Unmarshal(data, &p); err != nil {
		return err
	}
	*m = ImportMapping(p)
	return nil
}

// ImportField feeds one target from a column (by header text, else by
// column letter) or from a constant.
type ImportField struct {
	Target string `json:"target" maxLength:"100" doc:"product.modelNumber, product.name.<locale>, product.description.<locale>, product.productType, product.category, variant.name.<locale>, variant.sku, variant.price, variant.image, addon.required, addon.optional or attribute.<key> (see GET /api/import-targets)"`
	// Column is matched against the header row ignoring case and repeated
	// white space.
	Column       string  `json:"column,omitempty" maxLength:"200" doc:"Header text, matched ignoring case and repeated white space"`
	ColumnLetter string  `json:"columnLetter,omitempty" maxLength:"3" doc:"Column letter (A, B, ..., AA), used when no header matches or no column is given"`
	Value        *string `json:"value,omitempty" maxLength:"1000" doc:"A constant for every row instead of a column (product type, category, names, descriptions, price and attributes); matched like a cell"`
}

// ImportProfile is a saved mapping, reused per supplier.
type ImportProfile struct {
	ID        uuid.UUID     `json:"id"`
	Name      string        `json:"name"`
	Mapping   ImportMapping `json:"mapping"`
	CreatedAt time.Time     `json:"createdAt"`
	UpdatedAt time.Time     `json:"updatedAt" doc:"Send it back as expectedUpdatedAt when updating"`
	Can       auth.Actions  `json:"can"`
}

type ImportProfileInput struct {
	Name    string        `json:"name" maxLength:"200" doc:"Unique ignoring case, at most 100 characters"`
	Mapping ImportMapping `json:"mapping"`
}

type ImportProfileUpdate struct {
	ImportProfileInput
	ExpectedUpdatedAt time.Time `json:"expectedUpdatedAt" doc:"updatedAt as last read; if the profile changed since, the update fails with import_profile.stale"`
}

// ImportTarget is something a column can be mapped to.
type ImportTarget struct {
	Target string `json:"target" doc:"The mapping target, e.g. product.name.de or attribute.width_te"`
	Group  string `json:"group" enum:"product,variant,addon,attribute"`
	// Repeatable targets may be mapped from several columns (add-ons, in
	// mapping order).
	Repeatable bool `json:"repeatable"`
	// Constant says whether a constant value may feed it.
	Constant bool `json:"constant" doc:"A constant value may feed it"`
	// ColumnOptional targets need no column: variant.image without one
	// takes the pictures floating over the row in any column.
	ColumnOptional bool `json:"columnOptional" doc:"May be mapped without a column (variant.image: pictures over the row in any column)"`
	Required       bool `json:"required" doc:"Every profile maps it (product.modelNumber; product.productType and product.category unless the profile fixes them)"`
	// Attribute describes attribute targets.
	Attribute *ImportAttributeTarget `json:"attribute,omitempty"`
}

// ImportAttributeTarget is an attribute key of one or more categories.
type ImportAttributeTarget struct {
	Key   string    `json:"key"`
	Label i18n.Text `json:"label" doc:"Label of the first category (in catalog order) that has it"`
	// Categories lists the categories whose schema has the key, with its
	// definition there.
	Categories []ImportAttributeOfCategory `json:"categories"`
}

// ImportAttributeOfCategory is an attribute's definition in one category.
type ImportAttributeOfCategory struct {
	CategoryID uuid.UUID                      `json:"categoryId"`
	Definition attrschema.AttributeDefinition `json:"definition"`
}

// ImportRun states.
const (
	StateUploaded  = "uploaded"
	StatePreviewed = "previewed"
	StateApplied   = "applied"
	StateFailed    = "failed"
	StateUndone    = "undone"
)

// ImportRun is one import: an uploaded file, its preview and, once applied, the
// change log.
type ImportRun struct {
	ID          uuid.UUID  `json:"id"`
	State       string     `json:"state" enum:"uploaded,previewed,applied,failed,undone" doc:"uploaded (no preview yet), previewed, applied, failed (apply rolled back) or undone"`
	FileID      uuid.UUID  `json:"fileId" doc:"The uploaded file (GET /api/files/{id})"`
	FileName    string     `json:"fileName"`
	FileSize    int64      `json:"fileSize" doc:"Bytes"`
	SourceKind  string     `json:"sourceKind" enum:"xlsx,csv"`
	ProfileID   *uuid.UUID `json:"profileId,omitempty" doc:"The profile the preview used (if it still exists)"`
	ProfileName string     `json:"profileName,omitempty"`
	UserName    string     `json:"userName" doc:"Who uploaded the file"`
	// ImportMapping is the mapping the preview used (a copy, so editing the
	// profile does not change the run).
	Mapping      *ImportMapping   `json:"mapping,omitempty"`
	AllOrNothing bool             `json:"allOrNothing"`
	Counts       *ImportCounts    `json:"counts,omitempty" doc:"What the preview found"`
	Applied      *ImportCounts    `json:"applied,omitempty" doc:"What the apply wrote (rows with errors skipped)"`
	Error        *ImportRunError  `json:"error,omitempty" doc:"Why the apply failed (state failed)"`
	CreatedAt    time.Time        `json:"createdAt"`
	PreviewedAt  *time.Time       `json:"previewedAt,omitempty"`
	AppliedAt    *time.Time       `json:"appliedAt,omitempty"`
	UndoneAt     *time.Time       `json:"undoneAt,omitempty"`
	Can          ImportRunActions `json:"can"`
}

// ImportRunActions tells the client what it may do with the run now.
type ImportRunActions struct {
	Preview bool `json:"preview" doc:"Preview (again) with a profile or mapping"`
	Apply   bool `json:"apply"`
	Undo    bool `json:"undo"`
}

// ImportRunError is why an apply failed: an error code with params, at a row.
type ImportRunError struct {
	Code   string         `json:"code"`
	Params map[string]any `json:"params,omitempty"`
	Rows   []int          `json:"rows,omitempty" doc:"Rows of the item that failed"`
	Field  string         `json:"field,omitempty"`
}

type ImportRunPage struct {
	Items []ImportRun `json:"items"`
	Total int64       `json:"total"`
}

// ImportCounter counts items by status.
type ImportCounter struct {
	New        int `json:"new"`
	Changed    int `json:"changed"`
	Unchanged  int `json:"unchanged"`
	Deactivate int `json:"deactivate"`
}

// ImportAddonCounter counts add-on links.
type ImportAddonCounter struct {
	New        int `json:"new" doc:"Links to add"`
	Changed    int `json:"changed" doc:"Links whose required flag or position changes"`
	Unchanged  int `json:"unchanged"`
	Removed    int `json:"removed" doc:"Links of imported variants that the file no longer lists"`
	Unresolved int `json:"unresolved" doc:"References found neither in the file nor in the catalog"`
}

// ImportImageCounter counts variant images.
type ImportImageCounter struct {
	New       int `json:"new" doc:"Variants that get an image"`
	Changed   int `json:"changed" doc:"Variants whose image changes"`
	Unchanged int `json:"unchanged"`
	Files     int `json:"files" doc:"Distinct pictures used (stored as files)"`
}

// ImportCounts summarise a preview (or what an apply wrote).
type ImportCounts struct {
	Rows        int                `json:"rows" doc:"Data rows read (blank rows not counted)"`
	RowsSkipped int                `json:"rowsSkipped" doc:"Rows with errors (skipped, or blocking with all or nothing)"`
	Errors      int                `json:"errors"`
	Warnings    int                `json:"warnings"`
	Categories  ImportCounter      `json:"categories" doc:"Only new: categories to create"`
	Products    ImportCounter      `json:"products"`
	Variants    ImportCounter      `json:"variants"`
	Addons      ImportAddonCounter `json:"addons"`
	Images      ImportImageCounter `json:"images"`
	// Unmapped lists the header columns no mapping uses (ignored).
	Unmapped []ImportSourceColumn `json:"unmapped"`
}

// ImportSourceColumn is a column of the file.
type ImportSourceColumn struct {
	Letter string `json:"letter" example:"G"`
	Header string `json:"header" example:"Model Number"`
}

// ImportItem is one entry of a preview's diff.
type ImportItem struct {
	Seq    int    `json:"seq"`
	Entity string `json:"entity" enum:"category,product,variant"`
	Status string `json:"status" enum:"new,changed,unchanged,deactivate"`
	// Skipped items belong to rows with errors and are not applied.
	Skipped bool  `json:"skipped" doc:"Its rows have errors: not applied (or, all or nothing, nothing is)"`
	Rows    []int `json:"rows" doc:"File rows of the item"`
	// ID is the existing product or variant.
	ID          *uuid.UUID `json:"id,omitempty" doc:"The existing entity"`
	ProductID   *uuid.UUID `json:"productId,omitempty" doc:"A variant's existing product"`
	ModelNumber string     `json:"modelNumber,omitempty"`
	Key         string     `json:"key,omitempty" doc:"A new category's key"`
	Name        i18n.Text  `json:"name,omitempty" doc:"Category, product or variant name"`
	SKU         string     `json:"sku,omitempty"`
	// ProductType and Category are a product's system and category.
	ProductType *ImportTypeRef      `json:"productType,omitempty" doc:"A product's product type (system)"`
	Category    *ImportCategoryRef  `json:"category,omitempty" doc:"A product's category"`
	Changes     []ImportFieldChange `json:"changes" doc:"Fields that change (all set fields for new items)"`
}

// ImportTypeRef names a product type (system) in the diff; the import
// never creates product types.
type ImportTypeRef struct {
	ID           uuid.UUID `json:"id"`
	Key          string    `json:"key"`
	Name         i18n.Text `json:"name"`
	Abbreviation string    `json:"abbreviation,omitempty"`
	Color        string    `json:"color,omitempty"`
}

// ImportCategoryRef names a category in the diff.
type ImportCategoryRef struct {
	ID   *uuid.UUID `json:"id,omitempty" doc:"Unset for a category the import creates"`
	Key  string     `json:"key"`
	Name i18n.Text  `json:"name"`
}

// ImportFieldChange is one field's value before and after the import.
type ImportFieldChange struct {
	Field  string `json:"field" doc:"modelNumber, productType, category, name.<locale>, description.<locale>, attributes.<key>, isActive, sku, price, image, addons"`
	Before any    `json:"before,omitempty"`
	After  any    `json:"after,omitempty"`
}

// ImportAddonRef is an add-on in the diff and the change log.
type ImportAddonRef struct {
	VariantID *uuid.UUID `json:"variantId,omitempty" doc:"Unset for a variant the import creates"`
	Label     string     `json:"label" doc:"SKU, or model number and variant name"`
	Required  bool       `json:"required"`
}

type ImportItemPage struct {
	Items []ImportItem `json:"items"`
	Total int64        `json:"total"`
}

// ImportIssue is a row error or warning.
type ImportIssue struct {
	Severity    string         `json:"severity" enum:"error,warning"`
	Row         int            `json:"row" doc:"File row; 0 for the whole file"`
	Column      string         `json:"column,omitempty" doc:"Column letter"`
	Header      string         `json:"header,omitempty"`
	Target      string         `json:"target,omitempty" doc:"Mapping target of the column"`
	ModelNumber string         `json:"modelNumber,omitempty"`
	Code        string         `json:"code" doc:"Error code, translated like API errors"`
	Params      map[string]any `json:"params,omitempty"`
}

type ImportIssuePage struct {
	Items []ImportIssue `json:"items"`
	Total int64         `json:"total"`
}

// ImportChange is one entry of an applied run's change log.
type ImportChange struct {
	Seq      int       `json:"seq"`
	Entity   string    `json:"entity" enum:"category,product,variant,addons"`
	Action   string    `json:"action" enum:"create,update,deactivate"`
	EntityID uuid.UUID `json:"entityId" doc:"Category, product or variant (addons: the variant)"`
	Label    string    `json:"label" doc:"Model number, SKU or key"`
	Before   any       `json:"before,omitempty" doc:"The stored state before (none for creates)"`
	After    any       `json:"after" doc:"The state the import wrote"`
}

type ImportChangePage struct {
	Items []ImportChange `json:"items"`
	Total int64          `json:"total"`
}

// ImportSourcePreview shows a file's columns and first rows, for mapping.
type ImportSourcePreview struct {
	Sheets    []string             `json:"sheets" doc:"Sheet names (one empty name for CSV)"`
	Sheet     string               `json:"sheet"`
	HeaderRow int                  `json:"headerRow"`
	Columns   []ImportSourceColumn `json:"columns" doc:"Every column up to the last used one, with its header text"`
	Rows      []ImportSourceRow    `json:"rows" doc:"The first data rows after the header row"`
	DataRows  int                  `json:"dataRows" doc:"Non-blank rows after the header row"`
	Images    int                  `json:"images" doc:"Pictures anchored to rows"`
}

// ImportSourceRow is a row of the source preview.
type ImportSourceRow struct {
	Number int      `json:"number"`
	Cells  []string `json:"cells" doc:"Aligned with columns"`
	Images int      `json:"images"`
}
