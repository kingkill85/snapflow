// Package categories manages categories: the kinds of device in the global
// catalog (gateway, touchscreen, dimmer actuator, ...). A category defines
// which attributes its products have (attribute schemas, see
// platform/attrschema); the system or product line a product belongs to is
// its product type (features/producttypes). Reads need catalog.read, writes
// catalog.write.
package categories

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/categories/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/attrschema"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

type Category struct {
	ID          uuid.UUID         `json:"id"`
	Key         string            `json:"key" doc:"Stable identifier, lower snake case" example:"dimmer_actuator"`
	Name        i18n.Text         `json:"name" doc:"Display name per locale"`
	Description i18n.Text         `json:"description,omitempty" doc:"Description per locale"`
	SortOrder   int32             `json:"sortOrder" doc:"Position in the catalog, 1 first"`
	IsActive    bool              `json:"isActive" doc:"Inactive categories are hidden from lists unless asked for"`
	Attributes  attrschema.Schema `json:"attributes" doc:"Values stored on each product, or on each variant (scope)"`
	// InstanceAttributes are filled in per installed unit in projects.
	InstanceAttributes attrschema.InstanceSchema `json:"instanceAttributes" doc:"Values per installed unit (bus address, MAC, ...), filled in projects"`
	// Mounting is where the category's products are placed (D189); a
	// product may override it.
	Mounting  string       `json:"mounting" enum:"floorplan,board,both" doc:"Where products are placed: the floorplan, the distribution board, or both"`
	CreatedAt time.Time    `json:"createdAt"`
	UpdatedAt time.Time    `json:"updatedAt" doc:"Send it back as expectedUpdatedAt when updating"`
	Can       auth.Actions `json:"can"`
}

type CategoryInput struct {
	Key                string                    `json:"key" doc:"Lower snake case, 1-64 characters" example:"dimmer_actuator"`
	Name               i18n.Text                 `json:"name" doc:"Display name per locale (at most 100 characters); \"en\" is required"`
	Description        i18n.Text                 `json:"description,omitempty" doc:"Description per locale (at most 2000 characters); if set, \"en\" is required"`
	IsActive           bool                      `json:"isActive"`
	Attributes         attrschema.Schema         `json:"attributes" doc:"At most 200"`
	InstanceAttributes attrschema.InstanceSchema `json:"instanceAttributes" doc:"At most 200"`
	Mounting           string                    `json:"mounting,omitempty" enum:"floorplan,board,both" doc:"Default floorplan; on update, left out keeps the stored value (D294)"`
}

// CategoryUpdate is the body of an update: the input plus the version it
// was edited from.
type CategoryUpdate struct {
	CategoryInput
	ExpectedUpdatedAt time.Time `json:"expectedUpdatedAt" doc:"updatedAt of the category as last read; if it changed since, the update fails with category.stale"`
}

// Limits of a category.
const (
	MaxKeyLength         = 64
	MaxNameLength        = 100
	MaxDescriptionLength = 2000
)

// orderLockKey is the advisory lock (pg_advisory_xact_lock) that serialises
// assigning sort orders. Advisory lock keys must be unique in the app.
const orderLockKey int64 = 0x5f_63_61_74_6f_72_64 // "_catord"

var keyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// DB is the database the service runs on; *pgxpool.Pool implements it.
type DB interface {
	store.DBTX
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

type Service struct {
	db     DB
	q      *store.Queries
	fields *capabilities.Service
}

// NewService needs the capabilities service for the catalog fields that
// attributes link (fieldKey).
func NewService(db DB, fields *capabilities.Service) *Service {
	return &Service{db: db, q: store.New(db), fields: fields}
}

// WithTx returns the service working inside tx (see database.Nested): its
// transactions become savepoints, so a refused write leaves tx usable.
func (s *Service) WithTx(tx pgx.Tx) *Service {
	return NewService(database.NewNested(tx), s.fields.WithTx(tx))
}

// FieldInUse reports whether a category attribute links the catalog field
// key (capabilities.FieldUsage).
func (s *Service) FieldInUse(ctx context.Context, key string) (bool, error) {
	return s.q.FieldInUse(ctx, key)
}

// inTx runs fn in one transaction; any error rolls it back. A transaction
// aborted by a deadlock or serialization failure is run again (at most
// database.TxAttempts times, then 409 request.conflict_retry), so fn must be
// safe to repeat.
func (s *Service) inTx(ctx context.Context, fn func(q *store.Queries) error) error {
	return database.InTx(ctx, s.db, pgx.TxOptions{}, func(tx pgx.Tx) error { return fn(s.q.WithTx(tx)) })
}

// List returns the categories in catalog order; inactive ones only with
// includeInactive.
func (s *Service) List(ctx context.Context, includeInactive bool) ([]Category, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogRead)
	if err != nil {
		return nil, err
	}
	rows, err := s.q.ListCategories(ctx, includeInactive)
	if err != nil {
		return nil, err
	}
	return fromRows(actor, rows), nil
}

// Get returns a category, active or not.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (Category, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogRead)
	if err != nil {
		return Category{}, err
	}
	row, err := s.q.GetCategory(ctx, id)
	if err != nil {
		return Category{}, mapErr(err, "")
	}
	return fromRow(actor, row), nil
}

// Create adds a category at the end of the order.
func (s *Service) Create(ctx context.Context, in CategoryInput) (Category, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return Category{}, err
	}
	in, err = s.validate(ctx, in)
	if err != nil {
		return Category{}, err
	}
	var row store.Category
	err = s.inTx(ctx, func(q *store.Queries) error {
		if err := q.LockCategoryOrder(ctx, orderLockKey); err != nil {
			return err
		}
		row, err = q.CreateCategory(ctx, store.CreateCategoryParams{
			Key: in.Key, Name: in.Name, Description: textPtr(in.Description),
			IsActive: in.IsActive, Attributes: in.Attributes, InstanceAttributes: in.InstanceAttributes,
			Mounting: in.Mounting,
		})
		return err
	})
	if err != nil {
		return Category{}, mapErr(err, in.Key)
	}
	return fromRow(actor, row), nil
}

// Update replaces a category; its position stays. It fails with
// category.stale if the category changed since in.ExpectedUpdatedAt (checked
// in the UPDATE itself, so concurrent saves cannot both win).
func (s *Service) Update(ctx context.Context, id uuid.UUID, in CategoryUpdate) (Category, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return Category{}, err
	}
	if in.Mounting == "" {
		// Left out keeps the stored mounting (D294).
		current, err := s.q.GetCategory(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return Category{}, apperr.NotFound("category.not_found")
		}
		if err != nil {
			return Category{}, err
		}
		in.Mounting = current.Mounting
	}
	in.CategoryInput, err = s.validate(ctx, in.CategoryInput)
	if err != nil {
		return Category{}, err
	}
	var row store.Category
	err = s.inTx(ctx, func(q *store.Queries) error {
		var err error
		row, err = q.UpdateCategory(ctx, store.UpdateCategoryParams{
			ID: id, Key: in.Key, Name: in.Name, Description: textPtr(in.Description),
			IsActive: in.IsActive, Attributes: in.Attributes, InstanceAttributes: in.InstanceAttributes,
			Mounting: in.Mounting, ExpectedUpdatedAt: in.ExpectedUpdatedAt,
		})
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		exists, err := s.q.CategoryExists(ctx, id)
		if err != nil {
			return Category{}, err
		}
		if exists {
			return Category{}, apperr.Conflict("category.stale", "the category was changed by someone else")
		}
		return Category{}, apperr.NotFound("category.not_found")
	}
	if err != nil {
		return Category{}, mapErr(err, in.Key)
	}
	return fromRow(actor, row), nil
}

// Delete removes a category. Categories that products use cannot be deleted
// (category.in_use); deactivate them instead.
func (s *Service) Delete(ctx context.Context, id uuid.UUID) error {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return err
	}
	var n int64
	err := s.inTx(ctx, func(q *store.Queries) error {
		var err error
		n, err = q.DeleteCategory(ctx, id)
		return err
	})
	if err != nil {
		return mapErr(err, "")
	}
	if n == 0 {
		return apperr.NotFound("category.not_found")
	}
	return nil
}

// Reorder sets the catalog order. ids must list every category (active
// or not) exactly once; the result is the full list in the new order.
func (s *Service) Reorder(ctx context.Context, ids []uuid.UUID) ([]Category, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return nil, err
	}
	var rows []store.Category
	err = s.inTx(ctx, func(q *store.Queries) error {
		if err := q.LockCategoryOrder(ctx, orderLockKey); err != nil {
			return err
		}
		existing, err := q.LockCategoryIDs(ctx)
		if err != nil {
			return err
		}
		if !sameSet(ids, existing) {
			return apperr.New(http.StatusUnprocessableEntity, "category.order_mismatch",
				"ids must list every category exactly once")
		}
		if err := q.SetCategoryOrder(ctx, ids); err != nil {
			return err
		}
		rows, err = q.ListCategories(ctx, true)
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
// Attributes linked to a catalog field take its unit and options (and must
// have its type).
func (s *Service) validate(ctx context.Context, in CategoryInput) (CategoryInput, error) {
	var errs []apperr.FieldError
	if in.Mounting == "" {
		in.Mounting = string(capabilities.MountingFloorplan)
	}
	if !capabilities.ValidMounting(in.Mounting) {
		errs = append(errs, apperr.Field("body.mounting", "validation.invalid", "mounting must be floorplan, board or both"))
	}
	linkErrs, err := s.linkFields(ctx, &in)
	if err != nil {
		return in, err
	}
	errs = append(errs, linkErrs...)
	if len(in.Key) > MaxKeyLength || !keyPattern.MatchString(in.Key) {
		errs = append(errs, apperr.Field("body.key", "category.key_format", "key must be lower snake case, 1-64 characters"))
	}
	in.Name = in.Name.Trimmed()
	errs = append(errs, in.Name.Check("body.name", MaxNameLength)...)
	if !in.Name.Valid() {
		errs = append(errs, apperr.Field("body.name.en", "validation.required", "English name is required"))
	}
	in.Description = in.Description.Trimmed()
	errs = append(errs, in.Description.Check("body.description", MaxDescriptionLength)...)
	if len(in.Description) > 0 && !in.Description.Valid() {
		errs = append(errs, apperr.Field("body.description.en", "validation.required", "English description is required when a description is set"))
	}
	var schemaErrs []apperr.FieldError
	in.Attributes, schemaErrs = attrschema.CheckSchema(in.Attributes, "body.attributes")
	errs = append(errs, schemaErrs...)
	in.InstanceAttributes, schemaErrs = attrschema.CheckInstanceSchema(in.InstanceAttributes, "body.instanceAttributes")
	errs = append(errs, schemaErrs...)
	if len(errs) > 0 {
		return in, apperr.Validation(errs...)
	}
	return in, nil
}

// linkFields applies the catalog fields that attributes link: the type must
// be the field's (attribute.field_type), unit and options come from the
// field; an unknown key is attribute.field_not_found.
func (s *Service) linkFields(ctx context.Context, in *CategoryInput) ([]apperr.FieldError, error) {
	linked := false
	for _, a := range in.Attributes {
		linked = linked || strings.TrimSpace(a.FieldKey) != ""
	}
	for _, a := range in.InstanceAttributes {
		linked = linked || strings.TrimSpace(a.FieldKey) != ""
	}
	if !linked {
		return nil, nil
	}
	fields, err := s.fields.FieldsByKey(ctx)
	if err != nil {
		return nil, err
	}
	var errs []apperr.FieldError
	link := func(d *attrschema.Definition, loc string) {
		d.FieldKey = strings.TrimSpace(d.FieldKey)
		if d.FieldKey == "" {
			return
		}
		f, ok := fields[d.FieldKey]
		if !ok {
			errs = append(errs, apperr.Field(loc+".fieldKey", "attribute.field_not_found", "no such catalog field").With("key", d.FieldKey))
			return
		}
		if d.Type != f.Type {
			errs = append(errs, apperr.Field(loc+".type", "attribute.field_type", "the linked field has another type").
				With("expected", string(f.Type)).With("key", f.Key))
			return
		}
		linkedDef := f.Definition(d.Key)
		d.Unit, d.Options = linkedDef.Unit, linkedDef.Options
	}
	for i := range in.Attributes {
		link(&in.Attributes[i].Definition, fmt.Sprintf("body.attributes[%d]", i))
	}
	for i := range in.InstanceAttributes {
		link(&in.InstanceAttributes[i].Definition, fmt.Sprintf("body.instanceAttributes[%d]", i))
	}
	return errs, nil
}

func textPtr(t i18n.Text) *i18n.Text {
	if len(t) == 0 {
		return nil
	}
	return &t
}

func mapErr(err error, key string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("category.not_found")
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505": // unique_violation: the key is the only unique column
			return apperr.Conflict("category.key_taken", "key already exists").With("key", key)
		case "23503": // foreign_key_violation: products still use the category
			return apperr.Conflict("category.in_use", "products still use this category")
		}
	}
	return err
}

func fromRows(actor auth.Actor, rows []store.Category) []Category {
	out := make([]Category, len(rows))
	for i, r := range rows {
		out[i] = fromRow(actor, r)
	}
	return out
}

func fromRow(actor auth.Actor, r store.Category) Category {
	write := actor.Can(auth.PermCatalogWrite)
	c := Category{
		ID: r.ID, Key: r.Key, Name: r.Name, SortOrder: r.SortOrder, IsActive: r.IsActive,
		Attributes: r.Attributes, InstanceAttributes: r.InstanceAttributes, Mounting: r.Mounting,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		Can: auth.Actions{Update: write, Delete: write},
	}
	if r.Description != nil {
		c.Description = *r.Description
	}
	if c.Attributes == nil {
		c.Attributes = attrschema.Schema{}
	}
	if c.InstanceAttributes == nil {
		c.InstanceAttributes = attrschema.InstanceSchema{}
	}
	return c
}
