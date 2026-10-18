# SnapFlow 1 inventory

Behaviour of SnapFlow 1 ([kingkill85/snap-flow](https://github.com/kingkill85/snap-flow) at commit `6d951f2`), extracted from its code on 2026-10-18. File references point into that repo.

Use these files as acceptance criteria when building the matching SnapFlow 2 feature: carry each criterion over as a test, unless `docs/architecture.md` lists a decision that changes it. Items under "Suspected bugs" are not to be reproduced.

| File | Area |
| --- | --- |
| [01-catalog-import.md](01-catalog-import.md) | Catalog, product types, variants, addons, Excel sync |
| [02-projects-configurator.md](02-projects-configurator.md) | Projects, versions, floorplans, areas, placements, editor interactions |
| [03-bom-pricing-export.md](03-bom-pricing-export.md) | BOM snapshots, pricing formulas, invoice settings, DOCX export |
| [04-auth-tenants-mcp.md](04-auth-tenants-mcp.md) | Auth, roles, tenants, OAuth, MCP |
| [05-db-schema.md](05-db-schema.md) | Final SQLite schema, file storage, migration risks |
| [06-frontend-shell-tests.md](06-frontend-shell-tests.md) | Navigation, cross-cutting UX, UI audit, behaviours asserted by tests |
