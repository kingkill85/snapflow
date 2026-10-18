// Package migrations holds the SQL migrations for goose. sqlc reads the same
// files as its schema, so a migration is the single source of the schema.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
