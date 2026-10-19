-- Every query of this feature runs in database.InScope: row-level security
-- limits it to the tenants the caller may see.

-- NextSeq reserves the next proposal sequence of a version (atomic under
-- concurrency: the counter row is locked by the upsert).
-- name: NextSeq :one
INSERT INTO proposal_counters (version_id, tenant_id, last_seq)
VALUES (sqlc.arg(version_id), sqlc.arg(tenant_id), 1)
ON CONFLICT (version_id) DO UPDATE SET last_seq = proposal_counters.last_seq + 1
RETURNING last_seq;

-- name: InsertProposal :one
INSERT INTO proposals (tenant_id, version_id, seq, number, exporter, language, product_type_id, product_type_name,
    file_id, file_name, currency, exchange_rate, subtotal, discount, services, grand_total, converted_subtotal,
    converted_discount, converted_services, converted_grand_total, created_by)
VALUES (sqlc.arg(tenant_id), sqlc.arg(version_id), sqlc.arg(seq), sqlc.arg(number), sqlc.arg(exporter),
    sqlc.arg(language), sqlc.narg(product_type_id), sqlc.narg(product_type_name), sqlc.arg(file_id),
    sqlc.arg(file_name), sqlc.arg(currency), sqlc.arg(exchange_rate), sqlc.arg(subtotal), sqlc.arg(discount),
    sqlc.arg(services), sqlc.arg(grand_total), sqlc.narg(converted_subtotal), sqlc.narg(converted_discount),
    sqlc.narg(converted_services), sqlc.narg(converted_grand_total), sqlc.narg(created_by))
RETURNING *;

-- name: ListProposals :many
SELECT * FROM proposals WHERE version_id = $1 ORDER BY seq DESC, product_type_id NULLS FIRST, number;

-- name: GetProposal :one
SELECT * FROM proposals WHERE id = $1;

-- name: DeleteProposal :execrows
DELETE FROM proposals WHERE id = $1;
