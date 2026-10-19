package bom

import (
	"time"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// LineKind says where a BOM line comes from.
type LineKind string

const (
	KindCatalog  LineKind = "catalog"
	KindAddOn    LineKind = "addOn"
	KindFreeText LineKind = "freeText"
)

// SnapshotProductType is the frozen product type of a snapshot.
type SnapshotProductType struct {
	ID           uuid.UUID `json:"id"`
	Key          string    `json:"key"`
	Name         i18n.Text `json:"name"`
	Abbreviation string    `json:"abbreviation"`
	Color        string    `json:"color"`
}

// SnapshotCategory is the frozen category of a snapshot.
type SnapshotCategory struct {
	ID   uuid.UUID `json:"id"`
	Name i18n.Text `json:"name"`
}

// Snapshot is what a version keeps of a catalog variant (frozen values).
type ItemSnapshot struct {
	ProductName i18n.Text           `json:"productName"`
	VariantName i18n.Text           `json:"variantName"`
	ModelNumber string              `json:"modelNumber"`
	SKU         string              `json:"sku"`
	ProductType SnapshotProductType `json:"productType"`
	Category    SnapshotCategory    `json:"category"`
	ImageURL    *string             `json:"imageUrl" nullable:"true" doc:"Image download path; null for none"`
}

// Converted are amounts in the project currency.
type ConvertedLine struct {
	UnitPrice string `json:"unitPrice"`
	Total     string `json:"total"`
}

// LineStatus is the live catalog status of a line's variant.
type LineStatus struct {
	Available bool `json:"available" doc:"The variant can be offered (variant, product, product type and category active)"`
	Deleted   bool `json:"deleted" doc:"The variant was deleted from the catalog; the snapshot stays frozen"`
	Inactive  bool `json:"inactive" doc:"The variant exists but is not available"`
	Outdated  bool `json:"outdated" doc:"The snapshot differs from the catalog (price, names, model number, SKU, image, required add-ons)"`
}

// Quantities split a line's quantity by origin.
type LineQuantities struct {
	Plans   map[string]int64 `json:"plans" doc:"Per plan id"`
	Zones   map[string]int64 `json:"zones" doc:"Per zone id"`
	Unzoned map[string]int64 `json:"unzoned" doc:"Per plan id: placements outside every zone"`
	Manual  int64            `json:"manual" doc:"From manual lines"`
}

// Line is one line of the BOM.
type BOMLine struct {
	Key       string     `json:"key" doc:"Stable key: the variant id, or the manual line id of a free-text line"`
	Kind      LineKind   `json:"kind" enum:"catalog,addOn,freeText"`
	VariantID *uuid.UUID `json:"variantId" nullable:"true"`
	ProductID *uuid.UUID `json:"productId" nullable:"true"`
	// Snapshot is null for free-text lines.
	Snapshot   *NullableItemSnapshot  `json:"snapshot" doc:"Null for free-text lines"`
	Name       string                 `json:"name" doc:"Free-text lines: the line's name; empty otherwise"`
	UnitPrice  string                 `json:"unitPrice" doc:"USD, decimal string"`
	Quantity   int64                  `json:"quantity"`
	Quantities LineQuantities         `json:"quantities"`
	Total      string                 `json:"total" doc:"USD: unit price × quantity rounded half up to cents"`
	Converted  *NullableConvertedLine `json:"converted" doc:"In the project currency; null for USD projects"`
	Status     *NullableLineStatus    `json:"status" doc:"Null for free-text lines"`
	AddOnOf    []uuid.UUID            `json:"addOnOf" doc:"The variants this line is an add-on of"`
}

// Amounts are totals in one currency.
type BOMAmounts struct {
	Subtotal   string `json:"subtotal"`
	Discount   string `json:"discount"`
	Services   string `json:"services"`
	GrandTotal string `json:"grandTotal"`
}

// Totals are the version's totals in USD and, for other currencies,
// converted (each amount converted from its USD value on its own, so the
// converted grand total may differ from the sum of converted parts).
type BOMTotals struct {
	BOMAmounts
	Currency  string              `json:"currency"`
	Rate      string              `json:"rate"`
	Converted *NullableBOMAmounts `json:"converted" doc:"Null for USD projects"`
}

// CategoryGroup is the lines of one category within a product type.
type BOMCategoryGroup struct {
	Category  SnapshotCategory `json:"category"`
	Subtotal  string           `json:"subtotal"`
	Converted *string          `json:"converted" nullable:"true"`
	Lines     []string         `json:"lines" doc:"Line keys in order"`
}

// Group is the lines of one product type (or the free-text lines).
type BOMGroup struct {
	Kind        string                       `json:"kind" enum:"productType,freeText"`
	ProductType *NullableSnapshotProductType `json:"productType" doc:"Null for the free-text group"`
	Subtotal    string                       `json:"subtotal"`
	Converted   *string                      `json:"converted" nullable:"true"`
	Categories  []BOMCategoryGroup           `json:"categories" doc:"Empty for free text"`
	Lines       []string                     `json:"lines" doc:"Free text: the line keys; empty otherwise"`
}

// Warning is a placement the BOM cannot count.
type BOMWarning struct {
	Code        string    `json:"code" enum:"placement_without_snapshot"`
	PlanID      uuid.UUID `json:"planId"`
	PlacementID uuid.UUID `json:"placementId"`
}

// PlanRef names a plan and its zones (for the quantity columns and filters).
type BOMPlanRef struct {
	ID    uuid.UUID    `json:"id"`
	Name  string       `json:"name"`
	Zones []BOMZoneRef `json:"zones"`
}

// ZoneRef names a zone.
type BOMZoneRef struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

// BOM is the bill of materials of a version.
type BOM struct {
	Plans       []BOMPlanRef `json:"plans" doc:"The version's plans in order"`
	Lines       []BOMLine    `json:"lines" doc:"In BOM order"`
	Groups      []BOMGroup   `json:"groups"`
	Totals      BOMTotals    `json:"totals"`
	Pricing     Pricing      `json:"pricing"`
	ManualLines []ManualLine `json:"manualLines"`
	Warnings    []BOMWarning `json:"warnings"`
}

// Pricing are the version's pricing settings.
type Pricing struct {
	DiscountKind  string    `json:"discountKind" enum:"none,percent,amount"`
	DiscountValue string    `json:"discountValue" doc:"Percent (0-100, 2 decimals) or USD amount"`
	ServicesKind  string    `json:"servicesKind" enum:"none,percent,amount"`
	ServicesValue string    `json:"servicesValue" doc:"Percent (0-100, 2 decimals) or USD amount"`
	ServicesLabel i18n.Text `json:"servicesLabel"`
	// ServicesLabelDefault is the label a version without a label of its own
	// shows; a form sends {} for it, so the version keeps following the default.
	ServicesLabelDefault i18n.Text `json:"servicesLabelDefault" doc:"The default services label; send servicesLabel {} to use it"`
	IntroText            i18n.Text `json:"introText" doc:"Printed before the bill of materials of a proposal; {} for none"`
	ClosingText          i18n.Text `json:"closingText" doc:"Printed after the totals of a proposal (closing terms); {} for none"`
	// UpdatedAt is null while the version has the defaults.
	UpdatedAt *time.Time `json:"updatedAt" nullable:"true" doc:"Send it back as expectedUpdatedAt"`
}

// PricingInput are pricing settings to save or preview.
type PricingInput struct {
	DiscountKind  string    `json:"discountKind" enum:"none,percent,amount"`
	DiscountValue string    `json:"discountValue,omitempty" doc:"Percent 0-100 or USD amount, at most 2 decimals; ignored for none"`
	ServicesKind  string    `json:"servicesKind" enum:"none,percent,amount"`
	ServicesValue string    `json:"servicesValue,omitempty" doc:"Percent 0-100 or USD amount, at most 2 decimals; ignored for none"`
	ServicesLabel i18n.Text `json:"servicesLabel,omitempty" doc:"Per locale, at most 200 characters; empty for the default label"`
	IntroText     i18n.Text `json:"introText,omitempty" doc:"Per locale, at most 5000 characters; empty for none (en required otherwise)"`
	ClosingText   i18n.Text `json:"closingText,omitempty" doc:"Per locale, at most 5000 characters; empty for none (en required otherwise)"`
}

// PricingUpdate is a pricing save.
type PricingUpdate struct {
	PricingInput
	ExpectedUpdatedAt *time.Time `json:"expectedUpdatedAt" nullable:"true" doc:"The pricing's updatedAt as read; null while it had the defaults"`
}

// ManualLine is a line added by hand.
type ManualLine struct {
	ID        uuid.UUID  `json:"id"`
	Kind      LineKind   `json:"kind" enum:"catalog,freeText"`
	VariantID *uuid.UUID `json:"variantId" nullable:"true"`
	// Snapshot of a catalog line (null for free text).
	Snapshot  *NullableItemSnapshot  `json:"snapshot" doc:"Null for free text"`
	Name      string                 `json:"name" doc:"Free text only"`
	UnitPrice string                 `json:"unitPrice" doc:"USD; a catalog line's comes from its snapshot"`
	Quantity  int32                  `json:"quantity"`
	Total     string                 `json:"total" doc:"USD: unit price × quantity, rounded"`
	Converted *NullableConvertedLine `json:"converted" doc:"In the project currency; null for USD projects"`
	Note      string                 `json:"note"`
	UpdatedAt time.Time              `json:"updatedAt"`
}

// ManualLineInput creates or changes a manual line: either variantId (a
// catalog line) or name and unitPrice (free text).
type ManualLineInput struct {
	VariantID *uuid.UUID `json:"variantId,omitempty" nullable:"true" doc:"Catalog line: the variant"`
	Name      string     `json:"name,omitempty" doc:"Free-text line: 1-200 characters"`
	UnitPrice string     `json:"unitPrice,omitempty" doc:"Free-text line: USD, >= 0, at most 2 decimals"`
	Quantity  int32      `json:"quantity" doc:"1-100000"`
	Note      string     `json:"note,omitempty" doc:"At most 500 characters"`
}

// ManualLineUpdate changes a manual line.
type ManualLineUpdate struct {
	ManualLineInput
	ExpectedUpdatedAt time.Time `json:"expectedUpdatedAt"`
}

// ChangeValues are the compared values of a snapshot or of the catalog.
type ChangeValues struct {
	UnitPrice      string          `json:"unitPrice"`
	ProductName    i18n.Text       `json:"productName"`
	VariantName    i18n.Text       `json:"variantName"`
	ModelNumber    string          `json:"modelNumber"`
	SKU            string          `json:"sku"`
	ImageURL       *string         `json:"imageUrl" nullable:"true"`
	RequiredAddons []RequiredAddon `json:"requiredAddons"`
}

// RequiredAddon names a required add-on.
type RequiredAddon struct {
	VariantID   uuid.UUID `json:"variantId"`
	ModelNumber string    `json:"modelNumber" doc:"Empty when unknown (deleted)"`
	ProductName i18n.Text `json:"productName" doc:"Empty when unknown (deleted)"`
	VariantName i18n.Text `json:"variantName" doc:"Empty when unknown (deleted)"`
}

// CatalogChange is one used snapshot that differs from the catalog.
type CatalogChange struct {
	VariantID uuid.UUID    `json:"variantId"`
	ProductID uuid.UUID    `json:"productId"`
	Snapshot  ItemSnapshot `json:"snapshot"`
	// Fields lists what changed.
	Fields    []string              `json:"fields" doc:"unitPrice, productName, variantName, modelNumber, sku, image, requiredAddons"`
	Before    ChangeValues          `json:"before"`
	After     *NullableChangeValues `json:"after" doc:"Null when the variant was deleted"`
	Deleted   bool                  `json:"deleted"`
	Available bool                  `json:"available"`
	CanApply  bool                  `json:"canApply" doc:"False for deleted variants: their snapshot stays frozen"`
	Effect    string                `json:"effect" doc:"Change of the USD grand total when only this item is updated"`
}

// CatalogChanges is the preview of "Update from catalog".
type CatalogChanges struct {
	Items           []CatalogChange `json:"items"`
	GrandTotal      string          `json:"grandTotal" doc:"USD, as now"`
	GrandTotalAfter string          `json:"grandTotalAfter" doc:"USD, after updating every item that can be updated"`
	Effect          string          `json:"effect" doc:"grandTotalAfter − grandTotal"`
}

// ApplyInput selects the snapshots to update.
type ApplyInput struct {
	VariantIDs []uuid.UUID `json:"variantIds,omitempty" doc:"The variants to update"`
	All        bool        `json:"all,omitempty" doc:"Update every changed snapshot"`
}

// ApplyResult says what was updated.
type ApplyResult struct {
	Updated []uuid.UUID `json:"updated"`
	Skipped []uuid.UUID `json:"skipped" doc:"Deleted variants or unused/unchanged snapshots, left as they are"`
}

// Nullable wrappers: huma marks a schema nullable through a blank field with
// nullable:"true" (D243); the base types stay non-null where they are used
// as required objects.

// NullableItemSnapshot is an ItemSnapshot that may be null.
type NullableItemSnapshot struct {
	_ struct{} `nullable:"true"`
	ItemSnapshot
}

// NullableConvertedLine is a ConvertedLine that may be null.
type NullableConvertedLine struct {
	_ struct{} `nullable:"true"`
	ConvertedLine
}

// NullableLineStatus is a LineStatus that may be null.
type NullableLineStatus struct {
	_ struct{} `nullable:"true"`
	LineStatus
}

// NullableBOMAmounts are BOMAmounts that may be null.
type NullableBOMAmounts struct {
	_ struct{} `nullable:"true"`
	BOMAmounts
}

// NullableSnapshotProductType is a SnapshotProductType that may be null.
type NullableSnapshotProductType struct {
	_ struct{} `nullable:"true"`
	SnapshotProductType
}

// NullableChangeValues are ChangeValues that may be null.
type NullableChangeValues struct {
	_ struct{} `nullable:"true"`
	ChangeValues
}
