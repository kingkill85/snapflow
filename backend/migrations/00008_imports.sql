-- +goose Up
-- Catalog import (features/imports): saved mapping profiles, import runs with
-- their previewed diff and row issues, and the change log of applied runs
-- (for undo). The catalog itself is written through the products and
-- categories services only (the import never creates product types).

CREATE TABLE import_profiles (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL CHECK (name <> '' AND name = btrim(name)),
    -- The mapping (imports.Mapping): sheet, header and data rows, column to
    -- target assignments, constants and options.
    mapping    jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX import_profiles_name_key ON import_profiles (lower(name));

CREATE TABLE import_runs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The profile the preview used (its mapping is copied into mapping).
    profile_id     uuid REFERENCES import_profiles (id) ON DELETE SET NULL,
    profile_name   text,
    -- The uploaded file, kept with the run (features/files).
    file_id        uuid NOT NULL REFERENCES files (id) ON DELETE RESTRICT,
    file_name      text NOT NULL,
    file_size      bigint NOT NULL,
    source_kind    text NOT NULL CHECK (source_kind IN ('xlsx', 'csv')),
    user_id        uuid REFERENCES users (id) ON DELETE SET NULL,
    user_name      text NOT NULL DEFAULT '',
    state          text NOT NULL CHECK (state IN ('uploaded', 'previewed', 'applied', 'failed', 'undone')),
    mapping        jsonb,
    all_or_nothing boolean NOT NULL DEFAULT true,
    -- Identifies the catalog state the preview was computed on; apply
    -- refuses a preview whose catalog changed since (import.stale).
    catalog_token  text NOT NULL DEFAULT '',
    counts         jsonb NOT NULL DEFAULT '{}',
    -- Why a run failed: {code, params}.
    error          jsonb,
    created_at     timestamptz NOT NULL DEFAULT now(),
    previewed_at   timestamptz,
    applied_at     timestamptz,
    undone_at      timestamptz,
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_runs_created_at_idx ON import_runs (created_at DESC, id);

-- The previewed diff: one item per category to create, product and
-- variant (new, changed, unchanged, deactivate). item is what the API shows,
-- plan what apply does.
CREATE TABLE import_items (
    run_id  uuid NOT NULL REFERENCES import_runs (id) ON DELETE CASCADE,
    seq     integer NOT NULL,
    entity  text NOT NULL CHECK (entity IN ('category', 'product', 'variant')),
    status  text NOT NULL CHECK (status IN ('new', 'changed', 'unchanged', 'deactivate')),
    -- Rows with errors are skipped (or block the apply, all or nothing).
    skipped boolean NOT NULL DEFAULT false,
    item    jsonb NOT NULL,
    plan    jsonb NOT NULL,
    PRIMARY KEY (run_id, seq)
);

-- Row errors and warnings of a preview (and of an apply that skipped rows).
CREATE TABLE import_issues (
    run_id   uuid NOT NULL REFERENCES import_runs (id) ON DELETE CASCADE,
    seq      integer NOT NULL,
    severity text NOT NULL CHECK (severity IN ('error', 'warning')),
    issue    jsonb NOT NULL,
    PRIMARY KEY (run_id, seq)
);

-- What an applied run changed, with the state before and after (undo).
CREATE TABLE import_changes (
    run_id    uuid NOT NULL REFERENCES import_runs (id) ON DELETE CASCADE,
    seq       integer NOT NULL,
    entity    text NOT NULL CHECK (entity IN ('category', 'product', 'variant', 'addons')),
    action    text NOT NULL CHECK (action IN ('create', 'update', 'deactivate')),
    entity_id uuid NOT NULL,
    label     text NOT NULL,
    before    jsonb,
    after     jsonb NOT NULL,
    PRIMARY KEY (run_id, seq)
);

-- +goose Down
DROP TABLE import_changes;
DROP TABLE import_issues;
DROP TABLE import_items;
DROP TABLE import_runs;
DROP TABLE import_profiles;
