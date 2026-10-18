package products

import (
	"time"

	"github.com/google/uuid"

	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/attrschema"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// ProductTypeRef is what lists and editors show of a product's type.
type ProductTypeRef struct {
	ID       uuid.UUID `json:"id"`
	Key      string    `json:"key"`
	Name     i18n.Text `json:"name"`
	Color    string    `json:"color,omitempty" doc:"Badge colour, #rrggbb"`
	IsActive bool      `json:"isActive"`
}

// Product is one orderable device model with its variants.
type Product struct {
	ID            uuid.UUID      `json:"id"`
	ProductTypeID uuid.UUID      `json:"productTypeId"`
	ProductType   ProductTypeRef `json:"productType"`
	ModelNumber   string         `json:"modelNumber" example:"M485/GW-ZB.10"`
	Name          i18n.Text      `json:"name"`
	Description   i18n.Text      `json:"description,omitempty"`
	// Attributes are the product-scope values of keys the type's schema has
	// (also values that no longer satisfy it, see AttributeErrors).
	Attributes      attrschema.Values   `json:"attributes" doc:"Product-scope attribute values by key"`
	StaleAttributes attrschema.Values   `json:"staleAttributes" doc:"Values whose key the type's schema no longer has; kept until removed. Send them back in attributes to keep them, leave them out to remove them"`
	AttributeErrors []apperr.FieldError `json:"attributeErrors" doc:"Problems of the stored values against the current schema, at attributes.<key>"`
	IsActive        bool                `json:"isActive" doc:"The product's own flag"`
	Available       bool                `json:"available" doc:"Product and product type are active"`
	Variants        []Variant           `json:"variants" doc:"In variant order"`
	// VariantsWithProblems summarises the variants' attributeErrors and
	// staleAttributes, e.g. after a type change: variant values are flagged
	// against the current type, never re-validated or refused.
	VariantsWithProblems int          `json:"variantsWithProblems" doc:"Variants with attributeErrors or staleAttributes against the current type's schema"`
	CreatedAt            time.Time    `json:"createdAt"`
	UpdatedAt            time.Time    `json:"updatedAt" doc:"Send it back as expectedUpdatedAt when updating"`
	Can                  auth.Actions `json:"can"`
}

// Variant is a sellable version of a product (colour, finish) with a price.
type Variant struct {
	ID              uuid.UUID           `json:"id"`
	ProductID       uuid.UUID           `json:"productId"`
	Name            i18n.Text           `json:"name" doc:"e.g. Ivory White; \"Standard\" when a product has one variant"`
	SKU             string              `json:"sku,omitempty"`
	Price           string              `json:"price" doc:"List price in USD, a decimal string with two places" example:"27.00"`
	ImageFileID     *uuid.UUID          `json:"imageFileId,omitempty" doc:"Image, served at /api/files/{id}"`
	Attributes      attrschema.Values   `json:"attributes" doc:"Variant-scope attribute values by key"`
	StaleAttributes attrschema.Values   `json:"staleAttributes" doc:"As on the product"`
	AttributeErrors []apperr.FieldError `json:"attributeErrors" doc:"As on the product"`
	SortOrder       int32               `json:"sortOrder"`
	IsActive        bool                `json:"isActive" doc:"The variant's own flag"`
	Available       bool                `json:"available" doc:"Variant, product and product type are active"`
	Addons          []Addon             `json:"addons" doc:"In add-on order"`
	CreatedAt       time.Time           `json:"createdAt"`
	UpdatedAt       time.Time           `json:"updatedAt" doc:"Send it back as expectedUpdatedAt when updating"`
	Can             auth.Actions        `json:"can"`
}

// Addon is a link from a variant to another variant that goes with it.
type Addon struct {
	AddonVariantID uuid.UUID  `json:"addonVariantId"`
	ProductID      uuid.UUID  `json:"productId" doc:"Product of the add-on variant"`
	ModelNumber    string     `json:"modelNumber"`
	ProductName    i18n.Text  `json:"productName"`
	VariantName    i18n.Text  `json:"variantName"`
	Price          string     `json:"price" example:"4.50"`
	ImageFileID    *uuid.UUID `json:"imageFileId,omitempty"`
	Available      bool       `json:"available"`
	Required       bool       `json:"required" doc:"Added to the BOM automatically"`
	SortOrder      int32      `json:"sortOrder"`
}

// ProductListItem is one row of the product list.
type ProductListItem struct {
	ID            uuid.UUID      `json:"id"`
	ProductTypeID uuid.UUID      `json:"productTypeId"`
	ProductType   ProductTypeRef `json:"productType"`
	ModelNumber   string         `json:"modelNumber"`
	Name          i18n.Text      `json:"name"`
	IsActive      bool           `json:"isActive"`
	Available     bool           `json:"available" doc:"Product and product type are active"`
	VariantCount  int            `json:"variantCount" doc:"All variants, active or not"`
	PriceMin      string         `json:"priceMin,omitempty" doc:"Lowest price of the active variants" example:"27.00"`
	PriceMax      string         `json:"priceMax,omitempty" doc:"Highest price of the active variants" example:"31.50"`
	// PreviewImageFileID is the image of the first active variant (by
	// variant order) that has one.
	PreviewImageFileID *uuid.UUID   `json:"previewImageFileId,omitempty" doc:"Image of the first active variant that has one"`
	AttributeErrors    int          `json:"attributeErrors" doc:"Attribute problems of the product and its variants against the current schema"`
	StaleAttributes    int          `json:"staleAttributes" doc:"Stale values on the product and its variants"`
	Can                auth.Actions `json:"can"`
}

type ProductPage struct {
	Items []ProductListItem `json:"items"`
	Total int64             `json:"total" doc:"Matching products, all pages"`
}

// VariantSearchItem is one result of the variant search (add-on picker).
type VariantSearchItem struct {
	ID            uuid.UUID      `json:"id"`
	ProductID     uuid.UUID      `json:"productId"`
	ProductTypeID uuid.UUID      `json:"productTypeId"`
	ProductType   ProductTypeRef `json:"productType"`
	ModelNumber   string         `json:"modelNumber"`
	ProductName   i18n.Text      `json:"productName"`
	Name          i18n.Text      `json:"name" doc:"Variant name"`
	SKU           string         `json:"sku,omitempty"`
	Price         string         `json:"price" example:"27.00"`
	ImageFileID   *uuid.UUID     `json:"imageFileId,omitempty"`
	Available     bool           `json:"available"`
}

type VariantPage struct {
	Items []VariantSearchItem `json:"items"`
	Total int64               `json:"total"`
}

type ProductInput struct {
	ProductTypeID uuid.UUID         `json:"productTypeId" doc:"Must be active (product.type_inactive), except the type the product already has"`
	ModelNumber   string            `json:"modelNumber" doc:"Unique ignoring case, at most 100 characters, no control characters; stored trimmed and in Unicode NFC" example:"M485/GW-ZB.10"`
	Name          i18n.Text         `json:"name" doc:"At most 200 characters; \"en\" is required"`
	Description   i18n.Text         `json:"description,omitempty" doc:"At most 5000 characters; if set, \"en\" is required"`
	Attributes    attrschema.Values `json:"attributes,omitempty" doc:"Product-scope values by key; stale values are kept only if they are sent back"`
	IsActive      bool              `json:"isActive"`
}

type ProductUpdate struct {
	ProductInput
	ExpectedUpdatedAt time.Time `json:"expectedUpdatedAt" doc:"updatedAt as last read; if the product changed since, the update fails with product.stale"`
}

type VariantInput struct {
	Name        i18n.Text         `json:"name" doc:"Unique within the product (English, ignoring case); at most 100 characters; \"en\" is required"`
	SKU         string            `json:"sku,omitempty" doc:"Unique ignoring case when set; at most 100 characters, no control characters; stored trimmed and in Unicode NFC"`
	Price       string            `json:"price" doc:"USD as a decimal string: up to 10 digits, optionally a point and 1-2 decimals" example:"27.00"`
	ImageFileID *uuid.UUID        `json:"imageFileId,omitempty" doc:"An uploaded file (POST /api/files); leave out for no image"`
	Attributes  attrschema.Values `json:"attributes,omitempty" doc:"Variant-scope values by key"`
	IsActive    bool              `json:"isActive"`
}

type VariantUpdate struct {
	VariantInput
	ExpectedUpdatedAt time.Time `json:"expectedUpdatedAt" doc:"updatedAt as last read; if the variant changed since, the update fails with variant.stale"`
}

type AddonInput struct {
	AddonVariantID uuid.UUID `json:"addonVariantId"`
	Required       bool      `json:"required,omitempty" doc:"Default false (optional add-on)"`
}

// VariantSearchParams filter and page the variant search.
type VariantSearchParams struct {
	ProductTypeID *uuid.UUID
	Search        string
	Limit         int
	Offset        int
}

// ListParams filter and page the product list.
type ListParams struct {
	ProductTypeID   *uuid.UUID
	Search          string
	IncludeInactive bool
	Limit           int
	Offset          int
}
