package capabilities

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/features/capabilities/store"
	"github.com/kingkill85/snapflow/backend/internal/platform/apperr"
)

// ServedByHook edits which output kinds serve a function type from the
// function side (D444). It implements functiontypes.ServedBy and is
// registered at wiring time; functiontypes does not read these tables.
type ServedByHook struct{ s *Service }

// ServedByHook returns the hook for functiontypes.Service.SetServedBy.
func (s *Service) ServedByHook() ServedByHook { return ServedByHook{s: s} }

func (h ServedByHook) queries(tx pgx.Tx) *store.Queries {
	if tx == nil {
		return h.s.q
	}
	return h.s.q.WithTx(tx)
}

// ListServedBy returns the output kinds serving each function type, in the
// kinds' order; tx nil reads outside a transaction.
func (h ServedByHook) ListServedBy(ctx context.Context, tx pgx.Tx) (map[uuid.UUID][]uuid.UUID, error) {
	rows, err := h.queries(tx).ListServingKinds(ctx)
	if err != nil {
		return nil, err
	}
	out := map[uuid.UUID][]uuid.UUID{}
	for _, r := range rows {
		out[r.FunctionTypeID] = append(out[r.FunctionTypeID], r.OutputKindID)
	}
	return out, nil
}

// SetServedBy replaces the output kinds serving a function type (in tx).
// Every id must be an existing output kind (output_kind.not_found on
// body.outputKindIds[i]); the kinds that gain or lose the function get a
// new updated_at, so their open editors are stale (D56).
func (h ServedByHook) SetServedBy(ctx context.Context, tx pgx.Tx, functionTypeID uuid.UUID, kindIDs []uuid.UUID) error {
	q := h.queries(tx)
	// The lock the kind-side editors take: a concurrent edit of the same links
	// waits instead of failing on the primary key.
	if err := q.LockOrder(ctx, outputKindOrderLock); err != nil {
		return err
	}
	existing, err := q.ExistingOutputKindIDs(ctx, kindIDs)
	if err != nil {
		return err
	}
	known := map[uuid.UUID]bool{}
	for _, id := range existing {
		known[id] = true
	}
	var errs []apperr.FieldError
	for i, id := range kindIDs {
		if !known[id] {
			errs = append(errs, apperr.Field(fmt.Sprintf("body.outputKindIds[%d]", i), "output_kind.not_found", "no such output kind"))
		}
	}
	if len(errs) > 0 {
		return apperr.Validation(errs...)
	}
	old, err := q.DeleteServingKinds(ctx, functionTypeID)
	if err != nil {
		return err
	}
	if len(kindIDs) > 0 {
		if err := q.InsertServingKinds(ctx, store.InsertServingKindsParams{OutputKindIds: kindIDs, FunctionTypeID: functionTypeID}); err != nil {
			return err
		}
	}
	before := map[uuid.UUID]bool{}
	for _, id := range old {
		before[id] = true
	}
	after := map[uuid.UUID]bool{}
	for _, id := range kindIDs {
		after[id] = true
	}
	var changed []uuid.UUID
	for id := range before {
		if !after[id] {
			changed = append(changed, id)
		}
	}
	for id := range after {
		if !before[id] {
			changed = append(changed, id)
		}
	}
	if len(changed) == 0 {
		return nil
	}
	return q.TouchOutputKinds(ctx, changed)
}
