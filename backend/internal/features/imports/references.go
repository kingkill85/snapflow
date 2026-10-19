package imports

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/imports/store"
)

// ReferencedFiles returns those of ids that this feature's rows reference,
// read in tx: the files feature's reference check (files.Referencer, D269).
func (s *Service) ReferencedFiles(ctx context.Context, tx pgx.Tx, ids []uuid.UUID) ([]uuid.UUID, error) {
	return store.New(tx).ReferencedFiles(ctx, ids)
}
