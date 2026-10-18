# Decisions

Every product or design decision taken while building SnapFlow 2, newest step last. "Claude" decisions were made during implementation on a stated reason; overrule any of them and the next step changes the code. Open questions carry the assumption the code follows until they are answered.

## Open questions

None right now. New ones are added here with the assumption the code follows until they are answered.

## Decided

| # | Step | Decision | Reason | By |
| --- | --- | --- | --- | --- |
| D1 | 1a | Opaque server-side sessions (hashed token in Postgres, HttpOnly SameSite=Lax cookie; bearer accepted for API/MCP) instead of JWT + refresh tokens | Deactivation and role changes apply at once; cookies also authenticate image and file requests | Claude |
| D2 | 1a | Three fixed, ordered roles (admin > tenant_admin > user); the permission matrix lives in code (`platform/auth`), shown read-only on the Roles page | Explicit, testable matrix; custom roles are not needed yet | Claude |
| D3 | 1a | Permission checks run in the services, not in HTTP middleware | MCP (phase 4) calls the services and must inherit every check | Claude |
| D4 | 1a | Exactly one distributor tenant, created at startup, cannot be deactivated or deleted; admins must belong to it | Matches how SnapFlow is run; SnapFlow 1 allowed several distributors by accident | Claude |
| D5 | 1a | Nobody assigns or changes a role above their own; nobody changes their own role, tenant or active flag, deletes themselves, or sets their own password through user management | Closes SnapFlow 1's admin-takeover bug and prevents lock-outs | Claude |
| D6 | 1a | The last active admin cannot be demoted, deactivated or deleted (checked under a row lock) | Concurrent edits could otherwise leave no admin | Claude |
| D7 | 1a | Login limits count failed attempts per email and client IP (plus looser per-email and per-IP caps); `TRUSTED_PROXIES` decides which X-Forwarded-For entries are trusted | A per-email-only limit let anyone lock out any account | Claude |
| D8 | 1a | A correct password on a disabled account returns "account disabled" (as in SnapFlow 1) | Users need to know to contact their admin; it reveals only that the password is right | Claude |
| D9 | 1a | Passwords: argon2id, at least 8 characters everywhere; emails case-insensitive; a password change ends all other sessions; "sign out everywhere" exists | SnapFlow 1 had three different minimum lengths and no revocation | Claude |
| D10 | 1a | First admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` when no active admin exists; an existing user with that email is promoted | No hard-coded or logged passwords | Claude |
| D11 | 1a | The Roles page is visible to every logged-in user | The API allows it and users should see what their role may do | Claude |
| D12 | 1a | Postgres row-level security arrives in phase 2 with projects; until then tenant isolation is enforced in the services | Users are the only tenant-owned data so far | Claude |
| D13 | 2 | Deleting a partner tenant that has projects is a soft delete: the tenant is deactivated and archived, its projects and users are kept. Tenants without projects are hard-deleted (with their users) | Keeps project history | User |
| D14 | 1b | SnapFlow 1 categories and item types merge into product types; the old item type (e.g. Zigbee) becomes an attribute such as `bus_system` | The rewrite plan's migration table maps categories and item types to product types | Claude |
| D15 | 1b | Product types define two attribute schemas now (product/variant attributes and per-instance attributes); the channel template follows in phase 3 with distribution boards | Instance data is part of the plan's data model; channels are only needed by the board editor | Claude |
| D16 | 1b | Product types are edited on a page, not in a dialog | Attribute schemas are too long for a dialog | Claude |
| D17 | 1b | The catalog is global and maintained only by distributor admins (`catalog.write`); tenants cannot add their own products | Follows D4: the distributor runs SnapFlow and owns the catalog; same as SnapFlow 1 | Claude |
| D18 | 1c | One global list price per variant; tenant-specific pricing (markups, discounts) comes later as a tenant setting, not as catalog data | Follows D17: one catalog, one price list; discounts already live on the proposal | Claude |
| D19 | 1c | Catalog base currency is USD; projects store their own currency and exchange rate (architecture.md) | SnapFlow 1 prices are USD, so migrated prices and BOM snapshots stay exact | Claude |
| D20 | 1b | Metric only; attribute units are display text without conversion | The board designer's feet display is the only imperial use and can be a view option later | Claude |
