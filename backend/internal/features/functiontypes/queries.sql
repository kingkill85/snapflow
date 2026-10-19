-- name: ListFunctionTypes :many
SELECT * FROM function_types ORDER BY key;

-- name: GetFunctionType :one
SELECT * FROM function_types WHERE id = $1;

-- name: CreateFunctionType :one
INSERT INTO function_types (key, name, allows_circuit) VALUES ($1, $2, $3)
RETURNING *;

-- name: UpdateFunctionType :one
UPDATE function_types SET key = $2, name = $3, allows_circuit = $4, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: DeleteFunctionType :execrows
DELETE FROM function_types WHERE id = $1;

-- name: ListFunctionTypeLoadTypes :many
SELECT * FROM function_type_load_types ORDER BY function_type_id, load_type_id;

-- name: DeleteFunctionTypeLoadTypes :exec
DELETE FROM function_type_load_types WHERE function_type_id = $1;

-- name: InsertFunctionTypeLoadTypes :exec
INSERT INTO function_type_load_types (function_type_id, load_type_id)
SELECT sqlc.arg(function_type_id)::uuid, unnest(sqlc.arg(load_type_ids)::uuid[]);
