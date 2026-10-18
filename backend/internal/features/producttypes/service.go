// Package producttypes manages product types: the systems or product lines of
// the global catalog (Zigbee, KNX, HDL Buspro, ...), shown as a badge with an
// abbreviation and a colour. Projects choose their product types (phase 2).
// The kind of device and its attribute schema is the product's category
// (features/categories). Reads need catalog.read, writes catalog.write.
package producttypes

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/text/unicode/norm"

	"github.com/kingkill85/snapflow/backend/internal/features/producttypes/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

type ProductType struct {
	ID           uuid.UUID    `json:"id"`
	Key          string       `json:"key" doc:"Stable identifier, lower snake case" example:"zigbee"`
	Name         i18n.Text    `json:"name" doc:"Display name per locale"`
	Abbreviation string       `json:"abbreviation,omitempty" doc:"Badge text, upper case, at most 6 characters" example:"ZB"`
	Color        string       `json:"color,omitempty" doc:"Badge colour, #rrggbb" example:"#1f6feb"`
	SortOrder    int32        `json:"sortOrder" doc:"Position in the catalog, 1 first"`
	IsActive     bool         `json:"isActive" doc:"Inactive types are hidden from lists unless asked for"`
	CreatedAt    time.Time    `json:"createdAt"`
	UpdatedAt    time.Time    `json:"updatedAt" doc:"Send it back as expectedUpdatedAt when updating"`
	Can          auth.Actions `json:"can"`
}

type ProductTypeInput struct {
	Key          string    `json:"key" doc:"Lower snake case, 1-64 characters" example:"zigbee"`
	Name         i18n.Text `json:"name" doc:"Display name per locale (at most 100 characters); \"en\" is required"`
	Abbreviation string    `json:"abbreviation,omitempty" doc:"Badge text: at most 6 characters, no control characters; stored trimmed and upper case; empty for none" example:"ZB"`
	Color        string    `json:"color,omitempty" doc:"Badge colour, #rrggbb (stored lower case); empty for none" example:"#1f6feb"`
	IsActive     bool      `json:"isActive"`
}

// ProductTypeUpdate is the body of an update: the input plus the version it
// was edited from.
type ProductTypeUpdate struct {
	ProductTypeInput
	ExpectedUpdatedAt time.Time `json:"expectedUpdatedAt" doc:"updatedAt of the product type as last read; if it changed since, the update fails with product_type.stale"`
}

// Limits of a product type.
const (
	MaxKeyLength          = 64
	MaxNameLength         = 100
	MaxAbbreviationLength = 6
)

// orderLockKey is the advisory lock (pg_advisory_xact_lock) that serialises
// assigning sort orders. Advisory lock keys must be unique in the app.
const orderLockKey int64 = 0x5f_70_74_6f_72_64 // "_ptord"

var (
	keyPattern   = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	colorPattern = regexp.MustCompile(`^#[0-9a-f]{6}$`)
)

// DB is the database the service runs on; *pgxpool.Pool implements it.
type DB interface {
	store.DBTX
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

type Service struct {
	db DB
	q  *store.Queries
}

func NewService(db DB) *Service {
	return &Service{db: db, q: store.New(db)}
}

// inTx runs fn in one transaction; any error rolls it back. A transaction
// aborted by a deadlock or serialization failure is run again (at most
// database.TxAttempts times, then 409 request.conflict_retry), so fn must be
// safe to repeat.
func (s *Service) inTx(ctx context.Context, fn func(q *store.Queries) error) error {
	return database.InTx(ctx, s.db, pgx.TxOptions{}, func(tx pgx.Tx) error { return fn(s.q.WithTx(tx)) })
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
	var row store.ProductType
	err = s.inTx(ctx, func(q *store.Queries) error {
		if err := q.LockProductTypeOrder(ctx, orderLockKey); err != nil {
			return err
		}
		row, err = q.CreateProductType(ctx, store.CreateProductTypeParams{
			Key: in.Key, Name: in.Name, Abbreviation: strPtr(in.Abbreviation), Color: strPtr(in.Color),
			IsActive: in.IsActive,
		})
		return err
	})
	if err != nil {
		return ProductType{}, mapErr(err, in.Key)
	}
	return fromRow(actor, row), nil
}

// Update replaces a product type; its position stays. It fails with
// product_type.stale if the type changed since in.ExpectedUpdatedAt (checked
// in the UPDATE itself, so concurrent saves cannot both win).
func (s *Service) Update(ctx context.Context, id uuid.UUID, in ProductTypeUpdate) (ProductType, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return ProductType{}, err
	}
	in.ProductTypeInput, err = validate(in.ProductTypeInput)
	if err != nil {
		return ProductType{}, err
	}
	row, err := s.q.UpdateProductType(ctx, store.UpdateProductTypeParams{
		ID: id, Key: in.Key, Name: in.Name, Abbreviation: strPtr(in.Abbreviation), Color: strPtr(in.Color),
		IsActive:          in.IsActive,
		ExpectedUpdatedAt: in.ExpectedUpdatedAt,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		exists, err := s.q.ProductTypeExists(ctx, id)
		if err != nil {
			return ProductType{}, err
		}
		if exists {
			return ProductType{}, apperr.Conflict("product_type.stale", "the product type was changed by someone else")
		}
		return ProductType{}, apperr.NotFound("product_type.not_found")
	}
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
		if err := q.LockProductTypeOrder(ctx, orderLockKey); err != nil {
			return err
		}
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
// reported at once, at its exact location.
func validate(in ProductTypeInput) (ProductTypeInput, error) {
	var errs []apperr.FieldError
	if len(in.Key) > MaxKeyLength || !keyPattern.MatchString(in.Key) {
		errs = append(errs, apperr.Field("body.key", "product_type.key_format", "key must be lower snake case, 1-64 characters"))
	}
	in.Name = in.Name.Trimmed()
	errs = append(errs, in.Name.Check("body.name", MaxNameLength)...)
	if !in.Name.Valid() {
		errs = append(errs, apperr.Field("body.name.en", "validation.required", "English name is required"))
	}
	in.Abbreviation = strings.ToUpper(strings.TrimSpace(norm.NFC.String(in.Abbreviation)))
	switch {
	case strings.IndexFunc(in.Abbreviation, func(r rune) bool { return unicode.In(r, unicode.Cc, unicode.Cf) }) >= 0:
		errs = append(errs, apperr.Field("body.abbreviation", "validation.control_chars", "control characters are not allowed"))
	case utf8.RuneCountInString(in.Abbreviation) > MaxAbbreviationLength:
		errs = append(errs, apperr.Field("body.abbreviation", "validation.too_long",
			fmt.Sprintf("longer than %d characters", MaxAbbreviationLength)).With("max", MaxAbbreviationLength))
	}
	in.Color = strings.ToLower(strings.TrimSpace(in.Color))
	if in.Color != "" && !colorPattern.MatchString(in.Color) {
		errs = append(errs, apperr.Field("body.color", "product_type.color_format", "colour must be #rrggbb"))
	}
	if len(errs) > 0 {
		return in, apperr.Validation(errs...)
	}
	return in, nil
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
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
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		Can: auth.Actions{Update: write, Delete: write},
	}
	if r.Abbreviation != nil {
		pt.Abbreviation = *r.Abbreviation
	}
	if r.Color != nil {
		pt.Color = *r.Color
	}
	return pt
}
