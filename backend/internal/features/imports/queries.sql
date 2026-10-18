-- Import profiles, runs, their previewed items and issues, and the change log.
-- The catalog is never read or written here: the import goes through the
-- products, categories and files services (product types are only read).

-- name: ListProfiles :many
SELECT * FROM import_profiles ORDER BY lower(name), id;

-- name: GetProfile :one
SELECT * FROM import_profiles WHERE id = $1;

-- name: CreateProfile :one
INSERT INTO import_profiles (name, mapping) VALUES ($1, $2) RETURNING *;

-- CreateProfileIfMissing creates a profile unless one with the name exists.
-- name: CreateProfileIfMissing :exec
INSERT INTO import_profiles (name, mapping) VALUES ($1, $2) ON CONFLICT ((lower(name))) DO NOTHING;

-- name: CountProfiles :one
SELECT count(*) FROM import_profiles;

-- name: UpdateProfile :one
UPDATE import_profiles
SET name = $2, mapping = $3, updated_at = greatest(now(), updated_at + interval '1 microsecond')
WHERE id = $1 AND updated_at = sqlc.arg(expected_updated_at)
RETURNING *;

-- name: ProfileExists :one
SELECT EXISTS (SELECT 1 FROM import_profiles WHERE id = $1);

-- name: DeleteProfile :execrows
DELETE FROM import_profiles WHERE id = $1;


-- name: CreateRun :one
INSERT INTO import_runs (file_id, file_name, file_size, source_kind, user_id, user_name, state)
VALUES ($1, $2, $3, $4, $5, $6, 'uploaded')
RETURNING *;

-- name: GetRun :one
SELECT * FROM import_runs WHERE id = $1;

-- name: LockRun :one
SELECT * FROM import_runs WHERE id = $1 FOR UPDATE;

-- name: ListRuns :many
SELECT * FROM import_runs ORDER BY created_at DESC, id LIMIT sqlc.arg(row_limit) OFFSET sqlc.arg(row_offset);

-- name: CountRuns :one
SELECT count(*) FROM import_runs;

-- name: SetRunPreview :one
UPDATE import_runs
SET state = 'previewed', profile_id = $2, profile_name = $3, mapping = $4, all_or_nothing = $5,
    catalog_token = $6, counts = $7, error = NULL, previewed_at = now(), updated_at = now()
WHERE id = $1
RETURNING *;

-- name: SetRunState :one
UPDATE import_runs
SET state = $2, counts = $3, error = $4, all_or_nothing = $5,
    applied_at = CASE WHEN $2 = 'applied' THEN now() ELSE applied_at END,
    undone_at = CASE WHEN $2 = 'undone' THEN now() ELSE undone_at END,
    updated_at = now()
WHERE id = $1
RETURNING *;


-- name: DeleteItems :exec
DELETE FROM import_items WHERE run_id = $1;

-- name: InsertItems :copyfrom
INSERT INTO import_items (run_id, seq, entity, status, skipped, item, plan) VALUES ($1, $2, $3, $4, $5, $6, $7);

-- ListItems pages the diff; empty filters match everything.
-- name: ListItems :many
SELECT seq, item FROM import_items
WHERE run_id = $1
  AND (sqlc.arg(entity)::text = '' OR entity = sqlc.arg(entity))
  AND (sqlc.arg(status)::text = '' OR status = sqlc.arg(status))
  AND (NOT sqlc.arg(only_skipped)::boolean OR skipped)
ORDER BY seq
LIMIT sqlc.arg(row_limit) OFFSET sqlc.arg(row_offset);

-- name: CountItems :one
SELECT count(*) FROM import_items
WHERE run_id = $1
  AND (sqlc.arg(entity)::text = '' OR entity = sqlc.arg(entity))
  AND (sqlc.arg(status)::text = '' OR status = sqlc.arg(status))
  AND (NOT sqlc.arg(only_skipped)::boolean OR skipped);

-- name: ListPlan :many
SELECT seq, entity, status, skipped, item, plan FROM import_items WHERE run_id = $1 ORDER BY seq;


-- name: DeleteIssues :exec
DELETE FROM import_issues WHERE run_id = $1;

-- name: InsertIssues :copyfrom
INSERT INTO import_issues (run_id, seq, severity, issue) VALUES ($1, $2, $3, $4);

-- name: MaxIssueSeq :one
SELECT coalesce(max(seq), 0)::integer FROM import_issues WHERE run_id = $1;

-- name: ListIssues :many
SELECT issue FROM import_issues
WHERE run_id = $1 AND (sqlc.arg(severity)::text = '' OR severity = sqlc.arg(severity))
ORDER BY seq
LIMIT sqlc.arg(row_limit) OFFSET sqlc.arg(row_offset);

-- name: CountIssues :one
SELECT count(*) FROM import_issues
WHERE run_id = $1 AND (sqlc.arg(severity)::text = '' OR severity = sqlc.arg(severity));


-- name: InsertChanges :copyfrom
INSERT INTO import_changes (run_id, seq, entity, action, entity_id, label, before, after) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: ListChanges :many
SELECT * FROM import_changes WHERE run_id = $1 ORDER BY seq LIMIT sqlc.arg(row_limit) OFFSET sqlc.arg(row_offset);

-- name: CountChanges :one
SELECT count(*) FROM import_changes WHERE run_id = $1;

-- name: AllChanges :many
SELECT * FROM import_changes WHERE run_id = $1 ORDER BY seq;

-- LockImports serialises applies and undos of all runs until the
-- transaction ends.
-- name: LockImports :exec
SELECT pg_advisory_xact_lock(sqlc.arg(lock_key)::bigint);
