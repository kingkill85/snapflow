// Package roomtemplates manages room templates (step 3b): catalog
// configuration listing the needs of a typical room ("Living room,
// Comfort": 4 × dimmable light, 2 × blind, ...), applied to a zone in the
// floorplan editor. Changes need catalog.write; reading needs
// projects.read or catalog.read. Function types and load types are checked
// through their services.
package roomtemplates

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/features/capabilities"
	"github.com/kingkill85/snapflow/backend/internal/features/functiontypes"
	"github.com/kingkill85/snapflow/backend/internal/features/roomtemplates/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/i18n"
)

// Limits.
const (
	MaxKeyLength   = 64
	MaxNameLength  = 100
	MaxLevelLength = 50
	MaxLabelLength = 100
	MaxLines       = 100
	MaxQuantity    = 100
	MaxPowerW      = 100000
)

// orderLock serialises sort order assignment (advisory lock key, unique in
// the app): "_rtord".
const orderLock int64 = 0x5f_72_74_6f_72_64

var keyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// RoomTemplateLine is one line of a template: n needs of a function type.
type RoomTemplateLine struct {
	FunctionTypeID uuid.UUID  `json:"functionTypeId"`
	Quantity       int32      `json:"quantity" doc:"1-100"`
	PowerW         *float64   `json:"powerW" nullable:"true" doc:"Power per unit in W, 0-100000; null for unknown"`
	LoadTypeID     *uuid.UUID `json:"loadTypeId" nullable:"true" doc:"One of the function type's allowed load types (any when it lists none); null for none"`
	Label          string     `json:"label" doc:"At most 100 characters; empty for none"`
}

// RoomTemplate is a template of a room's needs.
type RoomTemplate struct {
	ID             uuid.UUID          `json:"id"`
	Key            string             `json:"key" example:"living_comfort"`
	Name           i18n.Text          `json:"name"`
	EquipmentLevel i18n.Text          `json:"equipmentLevel" doc:"Optional equipment level (\"Basic\", \"Comfort\"); {} for none"`
	SortOrder      int32              `json:"sortOrder"`
	IsActive       bool               `json:"isActive"`
	Lines          []RoomTemplateLine `json:"lines" doc:"In order"`
	CreatedAt      time.Time          `json:"createdAt"`
	UpdatedAt      time.Time          `json:"updatedAt" doc:"Send it back as expectedUpdatedAt when updating"`
	Can            auth.Actions       `json:"can"`
}

type RoomTemplateInput struct {
	Key            string             `json:"key" doc:"Lower snake case, 1-64 characters" example:"living_comfort"`
	Name           i18n.Text          `json:"name" doc:"At most 100 characters; \"en\" is required"`
	EquipmentLevel i18n.Text          `json:"equipmentLevel,omitempty" doc:"At most 50 characters per locale; \"en\" is required unless empty; left out or {} for none"`
	IsActive       bool               `json:"isActive"`
	Lines          []RoomTemplateLine `json:"lines" maxItems:"100" doc:"At most 100"`
}

type RoomTemplateUpdate struct {
	RoomTemplateInput
	ExpectedUpdatedAt time.Time `json:"expectedUpdatedAt" doc:"updatedAt as last read; if it changed since, the update fails with room_template.stale"`
}

// DB is the database the service runs on; *pgxpool.Pool implements it.
type DB interface {
	store.DBTX
	BeginTx(ctx context.Context, opts pgx.TxOptions) (pgx.Tx, error)
}

type Service struct {
	db            DB
	q             *store.Queries
	functionTypes *functiontypes.Service
	capabilities  *capabilities.Service
}

func NewService(db DB, functionTypeSvc *functiontypes.Service, capabilitySvc *capabilities.Service) *Service {
	return &Service{db: db, q: store.New(db), functionTypes: functionTypeSvc, capabilities: capabilitySvc}
}

func (s *Service) inTx(ctx context.Context, fn func(q *store.Queries) error) error {
	return database.InTx(ctx, s.db, pgx.TxOptions{}, func(tx pgx.Tx) error { return fn(s.q.WithTx(tx)) })
}

// requireRead: projects.read (planners apply templates) or catalog.read.
func requireRead(ctx context.Context) (auth.Actor, error) {
	actor, err := auth.Require(ctx)
	if err != nil {
		return actor, err
	}
	if actor.Can(auth.PermProjectsRead) {
		return actor, nil
	}
	return auth.Require(ctx, auth.PermCatalogRead)
}

// List returns the templates in order; inactive ones only with includeInactive.
func (s *Service) List(ctx context.Context, includeInactive bool) ([]RoomTemplate, error) {
	actor, err := requireRead(ctx)
	if err != nil {
		return nil, err
	}
	var (
		rows  []store.RoomTemplate
		lines []store.RoomTemplateLine
	)
	err = database.InTx(ctx, s.db, database.ReadOnlySnapshot, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		var err error
		if rows, err = q.ListTemplates(ctx, includeInactive); err != nil {
			return err
		}
		ids := make([]uuid.UUID, len(rows))
		for i, r := range rows {
			ids[i] = r.ID
		}
		lines, err = q.ListLines(ctx, ids)
		return err
	})
	if err != nil {
		return nil, err
	}
	byTemplate := map[uuid.UUID][]store.RoomTemplateLine{}
	for _, l := range lines {
		byTemplate[l.TemplateID] = append(byTemplate[l.TemplateID], l)
	}
	out := make([]RoomTemplate, len(rows))
	for i, r := range rows {
		out[i] = templateOut(actor, r, byTemplate[r.ID])
	}
	return out, nil
}

func (s *Service) Get(ctx context.Context, id uuid.UUID) (RoomTemplate, error) {
	actor, err := requireRead(ctx)
	if err != nil {
		return RoomTemplate{}, err
	}
	return s.get(ctx, actor, id)
}

func (s *Service) get(ctx context.Context, actor auth.Actor, id uuid.UUID) (RoomTemplate, error) {
	var (
		row   store.RoomTemplate
		lines []store.RoomTemplateLine
	)
	err := database.InTx(ctx, s.db, database.ReadOnlySnapshot, func(tx pgx.Tx) error {
		q := s.q.WithTx(tx)
		var err error
		if row, err = q.GetTemplate(ctx, id); err != nil {
			return err
		}
		lines, err = q.ListLines(ctx, []uuid.UUID{id})
		return err
	})
	if err != nil {
		return RoomTemplate{}, mapErr(err, "")
	}
	return templateOut(actor, row, lines), nil
}

func (s *Service) Create(ctx context.Context, in RoomTemplateInput) (RoomTemplate, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return RoomTemplate{}, err
	}
	if in, err = s.validate(ctx, in); err != nil {
		return RoomTemplate{}, err
	}
	var id uuid.UUID
	err = s.inTx(ctx, func(q *store.Queries) error {
		if err := q.LockOrder(ctx, orderLock); err != nil {
			return err
		}
		row, err := q.CreateTemplate(ctx, store.CreateTemplateParams{Key: in.Key, Name: in.Name, EquipmentLevel: levelOrNil(in.EquipmentLevel), IsActive: in.IsActive})
		if err != nil {
			return err
		}
		id = row.ID
		return insertLines(ctx, q, id, in.Lines)
	})
	if err != nil {
		return RoomTemplate{}, mapErr(err, in.Key)
	}
	return s.get(ctx, actor, id)
}

func (s *Service) Update(ctx context.Context, id uuid.UUID, in RoomTemplateUpdate) (RoomTemplate, error) {
	actor, err := auth.Require(ctx, auth.PermCatalogWrite)
	if err != nil {
		return RoomTemplate{}, err
	}
	if in.RoomTemplateInput, err = s.validate(ctx, in.RoomTemplateInput); err != nil {
		return RoomTemplate{}, err
	}
	err = s.inTx(ctx, func(q *store.Queries) error {
		_, err := q.UpdateTemplate(ctx, store.UpdateTemplateParams{ID: id, Key: in.Key, Name: in.Name,
			EquipmentLevel: levelOrNil(in.EquipmentLevel), IsActive: in.IsActive, ExpectedUpdatedAt: in.ExpectedUpdatedAt})
		if err != nil {
			return err
		}
		if err := q.DeleteLines(ctx, id); err != nil {
			return err
		}
		return insertLines(ctx, q, id, in.Lines)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		exists, xerr := s.q.TemplateExists(ctx, id)
		if xerr != nil {
			return RoomTemplate{}, xerr
		}
		if exists {
			return RoomTemplate{}, apperr.Conflict("room_template.stale", "changed by someone else")
		}
		return RoomTemplate{}, apperr.NotFound("room_template.not_found")
	}
	if err != nil {
		return RoomTemplate{}, mapErr(err, in.Key)
	}
	return s.get(ctx, actor, id)
}

func (s *Service) Delete(ctx context.Context, id uuid.UUID) error {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return err
	}
	n, err := s.q.DeleteTemplate(ctx, id)
	if err != nil {
		return err
	}
	if n == 0 {
		return apperr.NotFound("room_template.not_found")
	}
	return nil
}

// Reorder sets the order; ids must list every template exactly once.
func (s *Service) Reorder(ctx context.Context, ids []uuid.UUID) ([]RoomTemplate, error) {
	if _, err := auth.Require(ctx, auth.PermCatalogWrite); err != nil {
		return nil, err
	}
	err := s.inTx(ctx, func(q *store.Queries) error {
		if err := q.LockOrder(ctx, orderLock); err != nil {
			return err
		}
		existing, err := q.LockTemplateIDs(ctx)
		if err != nil {
			return err
		}
		if !sameSet(ids, existing) {
			return apperr.New(http.StatusUnprocessableEntity, "room_template.order_mismatch", "ids must list every template exactly once")
		}
		return q.SetTemplateOrder(ctx, ids)
	})
	if err != nil {
		return nil, err
	}
	return s.List(ctx, true)
}

// validate checks and normalises a template; the function types and load
// types are read through their services (before the transaction, D243).
func (s *Service) validate(ctx context.Context, in RoomTemplateInput) (RoomTemplateInput, error) {
	var errs []apperr.FieldError
	add := func(loc, code, detail string, params ...any) {
		f := apperr.Field(loc, code, detail)
		for i := 0; i+1 < len(params); i += 2 {
			f = f.With(params[i].(string), params[i+1])
		}
		errs = append(errs, f)
	}
	if !keyPattern.MatchString(in.Key) {
		add("body.key", "room_template.key_format", "key must be lower snake case")
	} else if len(in.Key) > MaxKeyLength {
		add("body.key", "validation.too_long", "too long", "max", MaxKeyLength)
	}
	in.Name = in.Name.Trimmed()
	errs = append(errs, in.Name.Check("body.name", MaxNameLength)...)
	if !in.Name.Valid() {
		add("body.name.en", "validation.required", "English name is required")
	}
	in.EquipmentLevel = in.EquipmentLevel.Trimmed()
	if len(in.EquipmentLevel) > 0 {
		errs = append(errs, in.EquipmentLevel.Check("body.equipmentLevel", MaxLevelLength)...)
		if !in.EquipmentLevel.Valid() {
			add("body.equipmentLevel.en", "validation.required", "English text is required")
		}
	}
	if len(in.Lines) > MaxLines {
		add("body.lines", "validation.too_many", "too many lines", "max", MaxLines)
		return in, apperr.Validation(errs...)
	}
	fts, err := s.functionTypes.List(ctx)
	if err != nil {
		return in, err
	}
	lts, err := s.capabilities.LoadTypes(ctx, true)
	if err != nil {
		return in, err
	}
	if in.Lines == nil {
		in.Lines = []RoomTemplateLine{}
	}
	for i := range in.Lines {
		l := &in.Lines[i]
		loc := fmt.Sprintf("body.lines[%d]", i)
		ft := slices.IndexFunc(fts, func(f functiontypes.FunctionType) bool { return f.ID == l.FunctionTypeID })
		switch {
		case ft < 0:
			add(loc+".functionTypeId", "function_type.not_found", "no such function type")
		case !fts[ft].IsActive:
			add(loc+".functionTypeId", "need.function_type_inactive", "the function type is inactive")
		}
		if l.Quantity < 1 || l.Quantity > MaxQuantity {
			add(loc+".quantity", "validation.range", "quantity out of range", "min", 1, "max", MaxQuantity)
		}
		if l.PowerW != nil && (math.IsNaN(*l.PowerW) || math.IsInf(*l.PowerW, 0) || *l.PowerW < 0 || *l.PowerW > MaxPowerW) {
			add(loc+".powerW", "validation.range", "power out of range", "min", 0, "max", MaxPowerW)
		}
		if l.LoadTypeID != nil {
			lt := slices.IndexFunc(lts, func(t capabilities.LoadType) bool { return t.ID == *l.LoadTypeID })
			switch {
			case lt < 0:
				add(loc+".loadTypeId", "load_type.not_found", "no such load type")
			case !lts[lt].IsActive:
				add(loc+".loadTypeId", "need.load_type_inactive", "the load type is inactive")
			case ft >= 0 && len(fts[ft].LoadTypeIDs) > 0 && !slices.Contains(fts[ft].LoadTypeIDs, *l.LoadTypeID):
				add(loc+".loadTypeId", "need.load_type_not_allowed", "the function type does not allow this load type")
			}
		}
		l.Label = strings.TrimSpace(l.Label)
		switch {
		case len([]rune(l.Label)) > MaxLabelLength:
			add(loc+".label", "validation.too_long", "too long", "max", MaxLabelLength)
		case strings.ContainsFunc(l.Label, unicode.IsControl):
			add(loc+".label", "validation.control_chars", "control characters are not allowed")
		}
	}
	if len(errs) > 0 {
		return in, apperr.Validation(errs...)
	}
	return in, nil
}

func levelOrNil(t i18n.Text) *i18n.Text {
	if len(t) == 0 {
		return nil
	}
	return &t
}

func insertLines(ctx context.Context, q *store.Queries, id uuid.UUID, lines []RoomTemplateLine) error {
	if len(lines) == 0 {
		return nil
	}
	type row struct {
		Position       int        `json:"position"`
		FunctionTypeID uuid.UUID  `json:"function_type_id"`
		Quantity       int32      `json:"quantity"`
		PowerW         *float64   `json:"power_w"`
		LoadTypeID     *uuid.UUID `json:"load_type_id"`
		Label          string     `json:"label"`
	}
	rows := make([]row, len(lines))
	for i, l := range lines {
		rows[i] = row{Position: i + 1, FunctionTypeID: l.FunctionTypeID, Quantity: l.Quantity, PowerW: l.PowerW,
			LoadTypeID: l.LoadTypeID, Label: l.Label}
	}
	data, err := json.Marshal(rows)
	if err != nil {
		return err
	}
	return q.InsertLines(ctx, store.InsertLinesParams{TemplateID: id, Rows: data})
}

func templateOut(actor auth.Actor, r store.RoomTemplate, lines []store.RoomTemplateLine) RoomTemplate {
	write := actor.Can(auth.PermCatalogWrite)
	out := RoomTemplate{ID: r.ID, Key: r.Key, Name: r.Name, SortOrder: r.SortOrder, IsActive: r.IsActive,
		Lines: make([]RoomTemplateLine, len(lines)), CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		Can: auth.Actions{Update: write, Delete: write}}
	out.EquipmentLevel = i18n.Text{}
	if r.EquipmentLevel != nil {
		out.EquipmentLevel = *r.EquipmentLevel
	}
	for i, l := range lines {
		out.Lines[i] = RoomTemplateLine{FunctionTypeID: l.FunctionTypeID, Quantity: l.Quantity, PowerW: l.PowerW, LoadTypeID: l.LoadTypeID, Label: l.Label}
	}
	return out
}

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
			return false
		}
		delete(want, id)
	}
	return true
}

func mapErr(err error, key string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("room_template.not_found")
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return apperr.Conflict("room_template.key_taken", "key already exists").With("key", key)
		case "23503":
			// A function type or load type deleted since validation.
			return apperr.Validation(apperr.Field("body.lines", "room_template.line_reference", "a function type or load type no longer exists"))
		}
	}
	return err
}
