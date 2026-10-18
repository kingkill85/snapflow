// Package producttypes manages product types: the kinds of device in the
// global catalog (dimmer actuator, wall switch, gateway, ...). A product type
// defines which attributes its products have (attribute schemas, see
// platform/attrschema). Reads need catalog.read, writes catalog.write.
package producttypes

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/features/producttypes/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/attrschema"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

type ProductType struct {
	ID          uuid.UUID         `json:"id"`
	Key         string            `json:"key" doc:"Stable identifier, lower snake case" example:"dimmer_actuator"`
	Name        i18n.Text         `json:"name" doc:"Display name per locale"`
	Description i18n.Text         `json:"description,omitempty" doc:"Description per locale"`
	SortOrder   int32             `json:"sortOrder" doc:"Position in the catalog, 1 first"`
	IsActive    bool              `json:"isActive" doc:"Inactive types are hidden from lists unless asked for"`
	Attributes  attrschema.Schema `json:"attributes" doc:"Values stored on each product, or on each variant (scope)"`
	// InstanceAttributes are filled in per installed unit in projects.
	InstanceAttributes attrschema.Schema `json:"instanceAttributes" doc:"Values per installed unit (bus address, MAC, ...), filled in projects"`
	CreatedAt          time.Time         `json:"createdAt"`
	UpdatedAt          time.Time         `json:"updatedAt"`
	Can                auth.Actions      `json:"can"`
}

type ProductTypeInput struct {
	Key                string            `json:"key" minLength:"1" maxLength:"64" example:"dimmer_actuator"`
	Name               i18n.Text         `json:"name" doc:"Display name per locale; \"en\" is required"`
	Description        i18n.Text         `json:"description,omitempty" doc:"Description per locale; if set, \"en\" is required"`
	IsActive           bool              `json:"isActive"`
	Attributes         attrschema.Schema `json:"attributes" maxItems:"200"`
	InstanceAttributes attrschema.Schema `json:"instanceAttributes" maxItems:"200"`
}

var keyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// DB is the database the service runs on; *pgxpool.Pool implements it.
type DB interface {
	store.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

type Service struct {
	db DB
	q  *store.Queries
}

func NewService(db DB) *Service {
	return &Service{db: db, q: store.New(db)}
}

// inTx runs fn in one transaction; any error rolls it back.
func (s *Service) inTx(ctx context.Context, fn func(q *store.Queries) error) error {
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error { return fn(s.q.WithTx(tx)) })
}

// List returns the product types in catalog order; inactive ones only with
// includeInactive.
func (s *Service) List(ctx context.Context, includeInactive bool) ([]ProductType, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogRead)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListProductTypes(ctx, includeInactive)
	if err != nil {
		return nil, err
	}
	return fromRows(actor, rows), nil
}

// Get returns a product type, active or not.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (ProductType, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogRead)
	if err != nil {
		return ProductType{}, err
	}
	row, err := s.q.GetProductType(ctx, id)
	if err != nil {
		return ProductType{}, mapErr(err, "")
	}
	return fromRow(actor, row), nil
}

// Create adds a product type at the end of the order.
func (s *Service) Create(ctx context.Context, in ProductTypeInput) (ProductType, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return ProductType{}, err
	}
	in, err = validate(in)
	if err != nil {
		return ProductType{}, err
	}
	row, err := s.q.CreateProductType(ctx, store.CreateProductTypeParams{
		Key: in.Key, Name: in.Name, Description: textPtr(in.Description), IsActive: in.IsActive,
		Attributes: in.Attributes, InstanceAttributes: in.InstanceAttributes,
	})
	if err != nil {
		return ProductType{}, mapErr(err, in.Key)
	}
	return fromRow(actor, row), nil
}

// Update replaces a product type; its position stays.
func (s *Service) Update(ctx context.Context, id uuid.UUID, in ProductTypeInput) (ProductType, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return ProductType{}, err
	}
	in, err = validate(in)
	if err != nil {
		return ProductType{}, err
	}
	row, err := s.q.UpdateProductType(ctx, store.UpdateProductTypeParams{
		ID: id, Key: in.Key, Name: in.Name, Description: textPtr(in.Description), IsActive: in.IsActive,
		Attributes: in.Attributes, InstanceAttributes: in.InstanceAttributes,
	})
	if err != nil {
		return ProductType{}, mapErr(err, in.Key)
	}
	return fromRow(actor, row), nil
}

// Delete removes a product type. Types that products use cannot be deleted
// (product_type.in_use); deactivate them instead.
func (s *Service) Delete(ctx context.Context, id uuid.UUID) error {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return err
	}
	n, err := s.q.DeleteProductType(ctx, id)
	if err != nil {
		return mapErr(err, "")
	}
	if n == 0 {
		return apperr.NotFound("product_type.not_found")
	}
	return nil
}

// Reorder sets the catalog order. ids must list every product type (active
// or not) exactly once; the result is the full list in the new order.
func (s *Service) Reorder(ctx context.Context, ids []uuid.UUID) ([]ProductType, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return nil, err
	}
	var rows []store.ProductType
	err = s.inTx(ctx, func(q *store.Queries) error {
		existing, err := q.LockProductTypeIDs(ctx)
		if err != nil {
			return err
		}
		if !sameSet(ids, existing) {
			return apperr.New(http.StatusUnprocessableEntity, "product_type.order_mismatch",
				"ids must list every product type exactly once")
		}
		if err := q.SetProductTypeOrder(ctx, ids); err != nil {
			return err
		}
		rows, err = q.ListProductTypes(ctx, true)
		return err
	})
	if err != nil {
		return nil, err
	}
	return fromRows(actor, rows), nil
}

// sameSet reports whether ids holds every id of existing exactly once.
func sameSet(ids, existing []uuid.UUID) bool {
	if len(ids) != len(existing) {
		return false
	}
	want := make(map[uuid.UUID]bool, len(existing))
	for _, id := range existing {
		want[id] = true
	}
	for _, id := range ids {
		if !want[id] {
			return false // unknown or repeated
		}
		delete(want, id)
	}
	return true
}

// validate checks the input and returns it normalised. Every problem is
// reported at once, at its exact location (e.g. body.attributes[2].key).
func validate(in ProductTypeInput) (ProductTypeInput, error) {
	var errs []apperr.FieldError
	if !keyPattern.MatchString(in.Key) {
		errs = append(errs, apperr.FieldError{Location: "body.key", Code: "product_type.key_format", Detail: "key must be lower snake case"})
	}
	in.Name = in.Name.Trimmed()
	if !in.Name.Valid() {
		errs = append(errs, apperr.FieldError{Location: "body.name.en", Code: "validation.required", Detail: "English name is required"})
	}
	in.Description = in.Description.Trimmed()
	if len(in.Description) > 0 && !in.Description.Valid() {
		errs = append(errs, apperr.FieldError{Location: "body.description.en", Code: "validation.required", Detail: "English description is required when a description is set"})
	}
	var schemaErrs []apperr.FieldError
	in.Attributes, schemaErrs = attrschema.CheckSchema(in.Attributes, attrschema.KindProduct, "body.attributes")
	errs = append(errs, schemaErrs...)
	in.InstanceAttributes, schemaErrs = attrschema.CheckSchema(in.InstanceAttributes, attrschema.KindInstance, "body.instanceAttributes")
	errs = append(errs, schemaErrs...)
	if len(errs) > 0 {
		return in, apperr.Validation(errs...)
	}
	return in, nil
}

func textPtr(t i18n.Text) *i18n.Text {
	if len(t) == 0 {
		return nil
	}
	return &t
}

func mapErr(err error, key string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("product_type.not_found")
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505": // unique_violation: the key is the only unique column
			return apperr.Conflict("product_type.key_taken", "key already exists").With("key", key)
		case "23503": // foreign_key_violation: products still use the type
			return apperr.Conflict("product_type.in_use", "products still use this product type")
		}
	}
	return err
}

func fromRows(actor auth.Actor, rows []store.ProductType) []ProductType {
	out := make([]ProductType, len(rows))
	for i, r := range rows {
		out[i] = fromRow(actor, r)
	}
	return out
}

func fromRow(actor auth.Actor, r store.ProductType) ProductType {
	write := actor.Can(auth.PermCatalogWrite)
	pt := ProductType{
		ID: r.ID, Key: r.Key, Name: r.Name, SortOrder: r.SortOrder, IsActive: r.IsActive,
		Attributes: r.Attributes, InstanceAttributes: r.InstanceAttributes,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		Can: auth.Actions{Update: write, Delete: write},
	}
	if r.Description != nil {
		pt.Description = *r.Description
	}
	if pt.Attributes == nil {
		pt.Attributes = attrschema.Schema{}
	}
	if pt.InstanceAttributes == nil {
		pt.InstanceAttributes = attrschema.Schema{}
	}
	return pt
}
