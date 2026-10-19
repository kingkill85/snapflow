package files

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/files/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
	"github.com/kingkill85/snapflow/backend/internal/platform/database"
)

// Referencer returns those of ids that rows of one feature reference, read
// in tx. tx sees the rows of every tenant (database.InAllTenants) and holds
// a lock on the files, so a feature answers with its own queries on its
// own tables (D269). Every feature with a file id column registers one.
type Referencer func(ctx context.Context, tx pgx.Tx, ids []uuid.UUID) ([]uuid.UUID, error)

// OnReferences registers a referencer. Call it while wiring the features,
// not concurrently with requests.
func (s *Service) OnReferences(r Referencer) { *s.referencers = append(*s.referencers, r) }

// DeleteIfUnreferenced deletes the tenant files among ids that no
// registered referencer references any more (D269): their rows in one
// transaction that locks them first, then their contents on disk once no
// file of any scope has the same contents. Catalog files are kept (D58):
// import history keeps their ids in its diffs and change log. Unknown ids
// are ignored. Callers call it after the transaction that removed their
// reference committed, with the permission of that change already checked.
func (s *Service) DeleteIfUnreferenced(ctx context.Context, ids ...uuid.UUID) error {
	if _, err := auth.Require(ctx); err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}
	var removed []string
	err := database.InAllTenants(ctx, s.db, pgx.TxOptions{}, func(tx pgx.Tx) error {
		removed = nil
		q := store.New(tx)
		rows, err := q.LockFiles(ctx, ids)
		if err != nil {
			return err
		}
		candidates := make([]uuid.UUID, 0, len(rows))
		sums := map[uuid.UUID]string{}
		for _, r := range rows {
			if r.TenantID == nil {
				continue
			}
			candidates = append(candidates, r.ID)
			sums[r.ID] = r.Sha256
		}
		referenced := map[uuid.UUID]bool{}
		for _, ref := range *s.referencers {
			if len(candidates) == 0 {
				break
			}
			used, err := ref(ctx, tx, candidates)
			if err != nil {
				return err
			}
			for _, id := range used {
				referenced[id] = true
			}
		}
		var unused []uuid.UUID
		for _, id := range candidates {
			if !referenced[id] {
				unused = append(unused, id)
				removed = append(removed, sums[id])
			}
		}
		if len(unused) == 0 {
			return nil
		}
		return q.DeleteFiles(ctx, unused)
	})
	if err != nil {
		return err
	}
	// The contents go after the commit, so a row never points to missing
	// bytes; the same bytes may still be a file of another scope.
	for _, sum := range removed {
		inUse, err := store.New(s.db).ContentInUse(ctx, sum)
		if err != nil {
			return err
		}
		if inUse {
			continue
		}
		if err := s.storage.Remove(sum); err != nil {
			return fmt.Errorf("files: remove contents %s: %w", sum, err)
		}
	}
	return nil
}

// DeleteUnreferencedLogged is DeleteIfUnreferenced after a change that has
// already committed: a failure is logged instead of failing that change,
// the files then stay like any unreferenced file (D58).
func (s *Service) DeleteUnreferencedLogged(ctx context.Context, ids ...uuid.UUID) {
	if err := s.DeleteIfUnreferenced(ctx, ids...); err != nil {
		slog.ErrorContext(ctx, "files: deleting unreferenced files failed", "files", ids, "error", err)
	}
}
