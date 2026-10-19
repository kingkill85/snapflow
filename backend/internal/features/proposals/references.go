package proposals

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/proposals/store"
)

// ReferencedFiles returns those of ids that this feature's rows reference,
// read in tx: the files feature's reference check (files.Referencer, D269).
func (s *Service) ReferencedFiles(ctx context.Context, tx pgx.Tx, ids []uuid.UUID) ([]uuid.UUID, error) {
	return store.New(tx).ReferencedFiles(ctx, ids)
}

// DeleteVersionFiles is the proposals' projects.VersionsDeleter: it reads the
// files of the proposals that go with the versions (by cascade) and deletes
// those nothing else references once the delete has committed (D269).
func (s *Service) DeleteVersionFiles(ctx context.Context, tx pgx.Tx, versionIDs []uuid.UUID) (func(context.Context), error) {
	ids, err := store.New(tx).FilesOfVersions(ctx, versionIDs)
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	return func(ctx context.Context) { s.files.DeleteUnreferencedLogged(ctx, ids...) }, nil
}
