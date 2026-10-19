package migrations_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kingkill85/snapflow/backend/internal/platform/database"
	"github.com/kingkill85/snapflow/backend/internal/platform/testdb"
)

func TestMain(m *testing.M) { os.Exit(testdb.Run(m)) }

// 00007_categories turns every product type into a category with the same id,
// texts, schemas, order and active flag, gives every product the category of
// its old type and drops the schema columns from product_types.
func TestCategoriesBackfill(t *testing.T) {
	ctx := context.Background()
	url := testdb.NewDatabase(t)
	if err := database.MigrateTo(ctx, url, 6); err != nil {
		t.Fatal(err)
	}
	db, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// The old shape: product types carry the schemas.
	const (
		dimmer  = "00000000-0000-0000-0000-00000000000a"
		gateway = "00000000-0000-0000-0000-00000000000b"
		unused  = "00000000-0000-0000-0000-00000000000c"
	)
	schema := `[{"key":"width_te","label":{"en":"Width"},"type":"integer","scope":"product","required":true}]`
	instance := `[{"key":"address","label":{"en":"Address"},"type":"integer"}]`
	mustExec(t, db, `
INSERT INTO product_types (id, key, name, description, color, sort_order, is_active, attributes, instance_attributes) VALUES
  ($1, 'dimmer_actuator', '{"en":"Dimmer actuator","de":"Dimmaktor"}', '{"en":"DIN rail"}', '#1f6feb', 2, true, $4, $5),
  ($2, 'gateway', '{"en":"Gateway"}', NULL, NULL, 1, false, '[]', '[]'),
  ($3, 'unused', '{"en":"Unused"}', NULL, '#000000', 3, true, '[]', '[]')`,
		dimmer, gateway, unused, schema, instance)
	mustExec(t, db, `
INSERT INTO products (product_type_id, model_number, name, attributes) VALUES
  ($1, 'DIM-1', '{"en":"Dimmer 1"}', '{"width_te":4}'),
  ($1, 'DIM-2', '{"en":"Dimmer 2"}', '{"width_te":6,"stale":true}'),
  ($2, 'GW-1', '{"en":"Gateway 1"}', '{}')`, dimmer, gateway)

	// The shape 00007 left (later migrations add columns).
	if err := database.MigrateTo(ctx, url, 7); err != nil {
		t.Fatal(err)
	}

	type category struct {
		ID, Key                                     string
		Name, Description, Attributes, InstanceAttr json.RawMessage
		SortOrder                                   int
		IsActive                                    bool
	}
	rows, err := db.Query(ctx, `
SELECT id::text, key, name, coalesce(description, 'null'), attributes, instance_attributes, sort_order, is_active
FROM categories ORDER BY sort_order`)
	if err != nil {
		t.Fatal(err)
	}
	var got []category
	for rows.Next() {
		var c category
		if err := rows.Scan(&c.ID, &c.Key, &c.Name, &c.Description, &c.Attributes, &c.InstanceAttr, &c.SortOrder, &c.IsActive); err != nil {
			t.Fatal(err)
		}
		got = append(got, c)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	want := []category{
		{gateway, "gateway", raw(`{"en":"Gateway"}`), raw(`null`), raw(`[]`), raw(`[]`), 1, false},
		{dimmer, "dimmer_actuator", raw(`{"en":"Dimmer actuator","de":"Dimmaktor"}`), raw(`{"en":"DIN rail"}`), raw(schema), raw(instance), 2, true},
		{unused, "unused", raw(`{"en":"Unused"}`), raw(`null`), raw(`[]`), raw(`[]`), 3, true},
	}
	if len(got) != len(want) {
		t.Fatalf("categories: %+v", got)
	}
	for i := range want {
		if !sameJSONRow(got[i], want[i]) {
			t.Errorf("category %d:\n got %s\nwant %s", i, dump(got[i]), dump(want[i]))
		}
	}

	// Every product has the category of its old type; values are unchanged.
	pairs := map[string][2]string{}
	prow, err := db.Query(ctx, `SELECT model_number, product_type_id::text, category_id::text FROM products`)
	if err != nil {
		t.Fatal(err)
	}
	for prow.Next() {
		var model, typeID, categoryID string
		if err := prow.Scan(&model, &typeID, &categoryID); err != nil {
			t.Fatal(err)
		}
		pairs[model] = [2]string{typeID, categoryID}
	}
	if err := prow.Err(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(pairs, map[string][2]string{
		"DIM-1": {dimmer, dimmer}, "DIM-2": {dimmer, dimmer}, "GW-1": {gateway, gateway},
	}) {
		t.Errorf("products: %v", pairs)
	}
	var stale string
	if err := db.QueryRow(ctx, `SELECT attributes::text FROM products WHERE model_number = 'DIM-2'`).Scan(&stale); err != nil {
		t.Fatal(err)
	}
	if !jsonEqual(raw(stale), raw(`{"width_te":6,"stale":true}`)) {
		t.Errorf("values changed: %s", stale)
	}

	// Product types keep key, name, colour, order and flag; the schemas and
	// the description are gone, the abbreviation is new.
	var columns []string
	crow, err := db.Query(ctx, `SELECT column_name FROM information_schema.columns WHERE table_name = 'product_types' ORDER BY column_name`)
	if err != nil {
		t.Fatal(err)
	}
	for crow.Next() {
		var c string
		if err := crow.Scan(&c); err != nil {
			t.Fatal(err)
		}
		columns = append(columns, c)
	}
	if !reflect.DeepEqual(columns, []string{"abbreviation", "color", "created_at", "id", "is_active", "key", "name", "sort_order", "updated_at"}) {
		t.Errorf("product_types columns: %v", columns)
	}
	var key, color string
	var order int
	var active bool
	if err := db.QueryRow(ctx, `SELECT key, color, sort_order, is_active FROM product_types WHERE id = $1`, dimmer).Scan(&key, &color, &order, &active); err != nil {
		t.Fatal(err)
	}
	if key != "dimmer_actuator" || color != "#1f6feb" || order != 2 || !active {
		t.Errorf("product type: %s %s %d %v", key, color, order, active)
	}

	// The category is required and in use.
	assertPgError(t, db, "23502", `INSERT INTO products (product_type_id, model_number, name) VALUES ($1, 'X', '{"en":"X"}')`, dimmer)
	assertPgError(t, db, "23503", `DELETE FROM categories WHERE id = $1`, dimmer)
	mustExec(t, db, `DELETE FROM categories WHERE id = $1`, unused)
	assertPgError(t, db, "23514", `UPDATE product_types SET abbreviation = 'TOOLONG' WHERE id = $1`, dimmer)
}

// Down and Up again: the schemas go back to the product types by id, then
// the backfill runs again. Categories without a product type of the same id,
// product types' abbreviations and product moves to other categories are
// lost (documented in the migration and D100).
func TestCategoriesDownAndUp(t *testing.T) {
	ctx := context.Background()
	url := testdb.NewDatabase(t)
	if err := database.MigrateTo(ctx, url, 6); err != nil {
		t.Fatal(err)
	}
	db, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	const dimmer = "00000000-0000-0000-0000-00000000000a"
	schema := `[{"key":"width_te","label":{"en":"Width"},"type":"integer","scope":"product"}]`
	mustExec(t, db, `INSERT INTO product_types (id, key, name, description, sort_order, attributes) VALUES ($1, 'dimmer', '{"en":"Dimmer"}', '{"en":"DIN rail"}', 1, $2)`, dimmer, schema)
	mustExec(t, db, `INSERT INTO products (product_type_id, model_number, name, attributes) VALUES ($1, 'DIM-1', '{"en":"Dimmer 1"}', '{"width_te":4}')`, dimmer)
	if err := database.Migrate(ctx, url); err != nil {
		t.Fatal(err)
	}
	// Changed after the migration: the schema, a category of its own, a badge.
	newSchema := `[{"key":"width_te","label":{"en":"Width"},"type":"integer","scope":"product","required":true}]`
	mustExec(t, db, `UPDATE categories SET attributes = $1 WHERE id = $2`, newSchema, dimmer)
	mustExec(t, db, `INSERT INTO categories (key, name, sort_order) VALUES ('sensors', '{"en":"Sensors"}', 2)`)
	mustExec(t, db, `UPDATE product_types SET abbreviation = 'DM' WHERE id = $1`, dimmer)

	if err := database.MigrateDownTo(ctx, url, 6); err != nil {
		t.Fatal(err)
	}
	var attrs, description string
	if err := db.QueryRow(ctx, `SELECT attributes::text, description::text FROM product_types WHERE id = $1`, dimmer).Scan(&attrs, &description); err != nil {
		t.Fatal(err)
	}
	if !jsonEqual(raw(attrs), raw(newSchema)) || !jsonEqual(raw(description), raw(`{"en":"DIN rail"}`)) {
		t.Errorf("after down: %s %s", attrs, description)
	}
	var categoriesLeft bool
	if err := db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'categories')`).Scan(&categoriesLeft); err != nil || categoriesLeft {
		t.Errorf("categories still there: %v %v", categoriesLeft, err)
	}

	// And up again.
	if err := database.Migrate(ctx, url); err != nil {
		t.Fatal(err)
	}
	var categoryID, categoryAttrs string
	if err := db.QueryRow(ctx, `SELECT p.category_id::text, c.attributes::text FROM products p JOIN categories c ON c.id = p.category_id`).Scan(&categoryID, &categoryAttrs); err != nil {
		t.Fatal(err)
	}
	if categoryID != dimmer || !jsonEqual(raw(categoryAttrs), raw(newSchema)) {
		t.Errorf("after up again: %s %s", categoryID, categoryAttrs)
	}
}

// On an empty database the migration creates the tables and nothing else.
func TestCategoriesEmptyDatabase(t *testing.T) {
	ctx := context.Background()
	url := testdb.NewDatabase(t)
	if err := database.Migrate(ctx, url); err != nil {
		t.Fatal(err)
	}
	db, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM categories`).Scan(&n); err != nil || n != 0 {
		t.Errorf("categories: %d %v", n, err)
	}
}

type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

func mustExec(t *testing.T, db execer, sql string, args ...any) {
	t.Helper()
	if _, err := db.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

func assertPgError(t *testing.T, db execer, code, sql string, args ...any) {
	t.Helper()
	_, err := db.Exec(context.Background(), sql, args...)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != code {
		t.Errorf("%s: got %v, want SQLSTATE %s", sql, err, code)
	}
}

func raw(s string) json.RawMessage { return json.RawMessage(s) }

func jsonEqual(a, b json.RawMessage) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	return reflect.DeepEqual(x, y)
}

func sameJSONRow(a, b any) bool {
	var x, y any
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	_ = json.Unmarshal(ja, &x)
	_ = json.Unmarshal(jb, &y)
	return reflect.DeepEqual(x, y)
}

func dump(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// 00017_capabilities seeds served function types, circuit flags and load
// types for the function types that exist, the relay pair alternative of the
// blind output, and rolls back with rows in its tables.
func TestCapabilitiesSeeds(t *testing.T) {
	ctx := context.Background()
	url := testdb.NewDatabase(t)
	if err := database.MigrateTo(ctx, url, 16); err != nil {
		t.Fatal(err)
	}
	db, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mustExec(t, db, `INSERT INTO function_types (key, name) VALUES
  ('dimmer', '{"en":"Dimmer"}'), ('blind', '{"en":"Blind"}'), ('input', '{"en":"Input"}'), ('custom', '{"en":"Custom"}')`)
	if err := database.MigrateTo(ctx, url, 17); err != nil {
		t.Fatal(err)
	}
	query := func(sql string) []string {
		t.Helper()
		rows, err := db.Query(ctx, sql)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var s string
			if err := rows.Scan(&s); err != nil {
				t.Fatal(err)
			}
			out = append(out, s)
		}
		return out
	}
	served := query(`SELECT o.key || ':' || f.key FROM output_kind_function_types x
JOIN output_kinds o ON o.id = x.output_kind_id JOIN function_types f ON f.id = x.function_type_id ORDER BY 1`)
	want := []string{"analog_0_10v_output:dimmer", "blind_output:blind", "dali_output:dimmer", "dimmer_output:dimmer", "input:input"}
	if !reflect.DeepEqual(served, want) {
		t.Errorf("served %v, want %v", served, want)
	}
	circuits := query(`SELECT key FROM function_types WHERE allows_circuit ORDER BY key`)
	if !reflect.DeepEqual(circuits, []string{"dimmer"}) {
		t.Errorf("circuits %v", circuits)
	}
	loads := query(`SELECT f.key || ':' || l.key FROM function_type_load_types x
JOIN function_types f ON f.id = x.function_type_id JOIN load_types l ON l.id = x.load_type_id ORDER BY 1`)
	if len(loads) != 8 || loads[0] != "blind:ac_motor" || loads[2] != "dimmer:capacitive" {
		t.Errorf("load types %v", loads)
	}
	alts := query(`SELECT o.key || '<-' || f.key || ':' || a.count FROM output_kind_alternatives a
JOIN output_kinds o ON o.id = a.output_kind_id JOIN output_kinds f ON f.id = a.from_kind_id`)
	if !reflect.DeepEqual(alts, []string{"blind_output<-relay_output:2"}) {
		t.Errorf("alternatives %v", alts)
	}
	// Rows in the new tables do not block the rollback; up again works.
	mustExec(t, db, `INSERT INTO catalog_fields (key, label, value_type, sort_order) VALUES ('width', '{"en":"Width"}', 'number', 1)`)
	mustExec(t, db, `INSERT INTO categories (key, name, attributes, instance_attributes, sort_order)
VALUES ('c', '{"en":"C"}', '[{"key":"w","label":{"en":"W"},"type":"number","fieldKey":"width"}]', '[]', 1)`)
	mustExec(t, db, `INSERT INTO category_field_links (category_id, field_key) SELECT id, 'width' FROM categories WHERE key = 'c'`)
	assertPgError(t, db, "23503", `DELETE FROM catalog_fields WHERE key = 'width'`)
	assertPgError(t, db, "23503", `UPDATE catalog_fields SET key = 'width2' WHERE key = 'width'`)
	mustExec(t, db, `UPDATE product_types SET topology = 'bus'`)
	if err := database.MigrateDownTo(ctx, url, 16); err != nil {
		t.Fatal(err)
	}
	if err := database.MigrateTo(ctx, url, 17); err != nil {
		t.Fatal(err)
	}
	if got := query(`SELECT key FROM output_kinds ORDER BY sort_order LIMIT 1`); !reflect.DeepEqual(got, []string{"dimmer_output"}) {
		t.Errorf("after down/up %v", got)
	}
}
