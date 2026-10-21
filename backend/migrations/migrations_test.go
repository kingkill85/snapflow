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

// 00025–00027 (D456): network assignments lose pinned, the two document
// counter tables become document_counters (numbers kept), version items lose
// badge, colour and positions; Down restores all three.
func TestModelCleanups(t *testing.T) {
	ctx := context.Background()
	url := testdb.NewDatabase(t)
	if err := database.MigrateTo(ctx, url, 24); err != nil {
		t.Fatal(err)
	}
	db, err := database.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	const (
		tenant  = "00000000-0000-0000-0000-0000000000a1"
		project = "00000000-0000-0000-0000-0000000000a2"
		version = "00000000-0000-0000-0000-0000000000a3"
		plan    = "00000000-0000-0000-0000-0000000000a4"
		line    = "00000000-0000-0000-0000-0000000000a5"
		ptype   = "00000000-0000-0000-0000-0000000000a6"
		cat     = "00000000-0000-0000-0000-0000000000a7"
		item    = "00000000-0000-0000-0000-0000000000a8"
		variant = "00000000-0000-0000-0000-0000000000a9"
	)
	mustExec(t, db, `INSERT INTO tenants (id, name) VALUES ($1, 'Acme')`, tenant)
	mustExec(t, db, `INSERT INTO projects (id, tenant_id, number, name, language) VALUES ($1, $2, 'P-1', 'House', 'en')`, project, tenant)
	mustExec(t, db, `INSERT INTO project_versions (id, tenant_id, project_id, name, position) VALUES ($1, $2, $3, 'V1', 1)`, version, tenant, project)
	mustExec(t, db, `INSERT INTO plans (id, tenant_id, version_id, kind, name, position) VALUES ($1, $2, $3, 'board', 'Board', 1)`, plan, tenant, version)
	mustExec(t, db, `INSERT INTO product_types (id, key, name, abbreviation, color, sort_order) VALUES ($1, 'knx', '{"en":"KNX"}', 'KNX', '#1f6feb', 3)`, ptype)
	mustExec(t, db, `INSERT INTO categories (id, key, name, sort_order) VALUES ($1, 'dimmer', '{"en":"Dimmer"}', 5)`, cat)
	mustExec(t, db, `INSERT INTO bus_lines (version_id, id, tenant_id, product_type_id, name, position) VALUES ($1, $2, $3, $4, 'Line 1', 1)`, version, line, tenant, ptype)
	mustExec(t, db, `INSERT INTO network_assignments (plan_id, item_id, tenant_id, version_id, bus_line_id) VALUES ($1, $2, $3, $4, $5)`, plan, item, tenant, version, line)
	mustExec(t, db, `INSERT INTO proposal_counters (version_id, tenant_id, last_seq) VALUES ($1, $2, 4)`, version, tenant)
	mustExec(t, db, `INSERT INTO generated_document_counters (version_id, kind, tenant_id, last_seq) VALUES ($1, 'installation_manual', $2, 2), ($1, 'channel_labels', $2, 7)`, version, tenant)
	mustExec(t, db, `
INSERT INTO version_items (tenant_id, version_id, variant_id, product_id, product_name, variant_name, model_number,
    product_type_id, product_type_key, product_type_name, product_type_abbreviation, product_type_color, product_type_position,
    category_id, category_name, category_position, unit_price)
VALUES ($1, $2, $3, $3, '{"en":"Dimmer"}', '{"en":"4x"}', 'DIM-4', $4, 'knx', '{"en":"KNX"}', 'OLD', '#000000', 9, $5, '{"en":"Dimmer"}', 9, 10)`,
		tenant, version, variant, ptype, cat)

	counters := func(table string) map[string]int {
		t.Helper()
		q := `SELECT kind, last_seq FROM ` + table
		if table == "proposal_counters" {
			q = `SELECT 'proposal', last_seq FROM proposal_counters`
		}
		rows, err := db.Query(ctx, q)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		out := map[string]int{}
		for rows.Next() {
			var k string
			var n int
			if err := rows.Scan(&k, &n); err != nil {
				t.Fatal(err)
			}
			out[k] = n
		}
		return out
	}
	hasColumn := func(table, column string) bool {
		t.Helper()
		var n int
		if err := db.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, table, column).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n == 1
	}

	if err := database.MigrateTo(ctx, url, 27); err != nil {
		t.Fatal(err)
	}
	if hasColumn("network_assignments", "pinned") {
		t.Error("network_assignments.pinned still there")
	}
	var assignments int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM network_assignments`).Scan(&assignments); err != nil || assignments != 1 {
		t.Errorf("assignments: %d %v", assignments, err)
	}
	if got, want := counters("document_counters"), map[string]int{"proposal": 4, "installation_manual": 2, "channel_labels": 7}; !reflect.DeepEqual(got, want) {
		t.Errorf("document_counters: %v, want %v", got, want)
	}
	for _, table := range []string{"proposal_counters", "generated_document_counters"} {
		var n int
		if err := db.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_name = $1`, table).Scan(&n); err != nil || n != 0 {
			t.Errorf("%s still there: %d %v", table, n, err)
		}
	}
	// The next proposal number continues after the copied one.
	var next int
	if err := db.QueryRow(ctx, `INSERT INTO document_counters (version_id, kind, tenant_id, last_seq) VALUES ($1, 'proposal', $2, 1)
ON CONFLICT (version_id, kind) DO UPDATE SET last_seq = document_counters.last_seq + 1 RETURNING last_seq`, version, tenant).Scan(&next); err != nil || next != 5 {
		t.Errorf("next proposal seq: %d %v", next, err)
	}
	var policy, insert bool
	if err := db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'document_counters' AND policyname = 'tenant_isolation'),
    has_table_privilege('snapflow_app', 'document_counters', 'INSERT')`).Scan(&policy, &insert); err != nil || !policy || !insert {
		t.Errorf("document_counters policy %v, app insert %v: %v", policy, insert, err)
	}
	var rls bool
	if err := db.QueryRow(ctx, `SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE relname = 'document_counters'`).Scan(&rls); err != nil || !rls {
		t.Errorf("document_counters row-level security: %v %v", rls, err)
	}
	for _, c := range []string{"product_type_abbreviation", "product_type_color", "product_type_position", "category_position"} {
		if hasColumn("version_items", c) {
			t.Errorf("version_items.%s still there", c)
		}
	}

	// Down: the columns and tables are back, the counters split again, the
	// item facts are the catalog's now.
	if err := database.MigrateDownTo(ctx, url, 24); err != nil {
		t.Fatal(err)
	}
	var pinned bool
	if err := db.QueryRow(ctx, `SELECT pinned FROM network_assignments`).Scan(&pinned); err != nil || !pinned {
		t.Errorf("pinned after down: %v %v", pinned, err)
	}
	if got, want := counters("proposal_counters"), map[string]int{"proposal": 5}; !reflect.DeepEqual(got, want) {
		t.Errorf("proposal_counters: %v", got)
	}
	if got, want := counters("generated_document_counters"), map[string]int{"installation_manual": 2, "channel_labels": 7}; !reflect.DeepEqual(got, want) {
		t.Errorf("generated_document_counters: %v", got)
	}
	var abbr, color string
	var typePos, catPos int
	if err := db.QueryRow(ctx, `SELECT product_type_abbreviation, product_type_color, product_type_position, category_position FROM version_items`).
		Scan(&abbr, &color, &typePos, &catPos); err != nil {
		t.Fatal(err)
	}
	if abbr != "KNX" || color != "#1f6feb" || typePos != 3 || catPos != 5 {
		t.Errorf("version item after down: %q %q %d %d", abbr, color, typePos, catPos)
	}
	// And up again.
	if err := database.MigrateTo(ctx, url, 27); err != nil {
		t.Fatal(err)
	}
	if got := counters("document_counters"); got["proposal"] != 5 || got["channel_labels"] != 7 {
		t.Errorf("document_counters after re-up: %v", got)
	}
}
