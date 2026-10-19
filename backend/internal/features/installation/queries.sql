-- Every query of this feature runs in database.InScope: row-level security
-- limits it to the tenants the caller may see.

-- NextSeq reserves the next sequence of a version and document kind.
-- name: NextSeq :one
INSERT INTO generated_document_counters (version_id, kind, tenant_id, last_seq)
VALUES (sqlc.arg(version_id), sqlc.arg(kind), sqlc.arg(tenant_id), 1)
ON CONFLICT (version_id, kind) DO UPDATE SET last_seq = generated_document_counters.last_seq + 1
RETURNING last_seq;

-- name: InsertDocument :one
INSERT INTO generated_documents (tenant_id, version_id, kind, seq, number, exporter, language, file_id, file_name, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING *;

-- name: ListDocuments :many
SELECT * FROM generated_documents WHERE version_id = $1 ORDER BY created_at DESC, kind, seq DESC;

-- name: GetDocument :one
SELECT * FROM generated_documents WHERE id = $1;

-- name: DeleteDocument :execrows
DELETE FROM generated_documents WHERE id = $1;

-- name: ReferencedFiles :many
SELECT DISTINCT file_id::uuid AS file_id FROM generated_documents WHERE file_id = ANY(sqlc.arg(ids)::uuid[]);

-- name: FilesOfVersions :many
SELECT DISTINCT file_id FROM generated_documents WHERE version_id = ANY(sqlc.arg(version_ids)::uuid[]);
