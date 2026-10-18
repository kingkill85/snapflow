package database

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/kingkill85/snapflow/backend/internal/platform/auth"
)

// AppRole is the database role tenant-scoped work runs as. It is not a
// superuser and has no BYPASSRLS, so the row-level security policies of the
// tenant-owned tables apply to it (migration 00012_projects).
const AppRole = "snapflow_app"

// InScope runs fn in one transaction (InTx: retried on deadlocks and
// serialization failures) that is scoped to actor: the transaction runs as
// AppRole with app.tenant_id set to the actor's tenant and app.access_all to
// whether the actor may see every tenant (tenants.access_all). The
// row-level security policies of the tenant-owned tables read those
// settings, so fn sees and changes only rows of tenants the actor may see,
// whatever its queries say. Everything is SET LOCAL: it ends with the
// transaction and never leaks to the next user of the pooled connection.
//
// This is the only place that sets the scope; features never set these
// settings themselves. Services still check tenants (actor.SeesTenant):
// row-level security is the second wall.
func InScope(ctx context.Context, db Beginner, actor auth.Actor, opts pgx.TxOptions, fn func(pgx.Tx) error) error {
	return InTx(ctx, db, opts, func(tx pgx.Tx) error {
		if err := SetScope(ctx, tx, actor); err != nil {
			return err
		}
		return fn(tx)
	})
}

// SetScope scopes the open transaction tx to actor (see InScope). Only
// InScope and tests that prove the policies use it.
func SetScope(ctx context.Context, tx pgx.Tx, actor auth.Actor) error {
	_, err := tx.Exec(ctx, `SELECT set_config('role', $1, true),
		set_config('app.tenant_id', $2, true), set_config('app.access_all', $3, true)`,
		AppRole, actor.TenantID.String(), onOff(actor.Can(auth.PermTenantsAccessAll)))
	return err
}

func onOff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}
