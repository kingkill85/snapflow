-- CreateFile stores a file's metadata in its scope (tenant_id NULL: the
-- catalog), or returns the existing row when the same bytes were stored in
-- that scope before (the no-op update makes RETURNING see it).
-- name: CreateFile :one
INSERT INTO files (tenant_id, sha256, content_type, size, width, height)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (tenant_id, sha256) DO UPDATE SET sha256 = EXCLUDED.sha256
RETURNING *;

-- name: GetFile :one
SELECT * FROM files WHERE id = $1;

-- FileExists reports whether a file exists in a scope (tenant_id NULL: the
-- catalog).
-- name: FileExists :one
SELECT EXISTS (SELECT 1 FROM files WHERE id = $1 AND tenant_id IS NOT DISTINCT FROM sqlc.narg(tenant_id)::uuid);

-- FileBySource returns the file an uploaded image became (file_sources) in
-- a scope, by the SHA-256 of the uploaded bytes.
-- name: FileBySource :one
SELECT f.* FROM file_sources s JOIN files f ON f.id = s.file_id
WHERE s.source_sha256 = $1 AND s.tenant_id IS NOT DISTINCT FROM sqlc.narg(tenant_id)::uuid;

-- name: AddFileSource :exec
INSERT INTO file_sources (tenant_id, source_sha256, file_id) VALUES ($1, $2, $3)
ON CONFLICT (tenant_id, source_sha256) DO NOTHING;

-- LockFiles locks files for a delete, so no row can start referencing them
-- (a foreign key check waits for the lock) until the delete commits.
-- name: LockFiles :many
SELECT id, tenant_id, sha256 FROM files WHERE id = ANY(sqlc.arg(ids)::uuid[]) ORDER BY id FOR UPDATE;

-- name: DeleteFiles :exec
DELETE FROM files WHERE id = ANY(sqlc.arg(ids)::uuid[]);

-- ContentInUse reports whether any file (of any scope) has these contents.
-- name: ContentInUse :one
SELECT EXISTS (SELECT 1 FROM files WHERE sha256 = $1);
