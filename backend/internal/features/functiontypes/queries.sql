-- name: ListFunctionTypes :many
SELECT * FROM function_types ORDER BY key;

-- name: GetFunctionType :one
SELECT * FROM function_types WHERE id = $1;

-- name: CreateFunctionType :one
INSERT INTO function_types (key, name) VALUES ($1, $2)
RETURNING *;

-- name: UpdateFunctionType :one
UPDATE function_types SET key = $2, name = $3, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: DeleteFunctionType :execrows
DELETE FROM function_types WHERE id = $1;
