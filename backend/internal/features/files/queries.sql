-- CreateFile stores a file's metadata, or returns the existing row when the
-- same bytes were stored before (the no-op update makes RETURNING see it).
-- name: CreateFile :one
INSERT INTO files (sha256, content_type, size, width, height)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (sha256) DO UPDATE SET sha256 = EXCLUDED.sha256
RETURNING *;

-- name: GetFile :one
SELECT * FROM files WHERE id = $1;

-- name: FileExists :one
SELECT EXISTS (SELECT 1 FROM files WHERE id = $1);
