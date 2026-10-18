# 04 — Auth, Users, Tenants, OAuth, MCP, Infrastructure (SnapFlow 1)

## Summary
Stateless HS256 JWT access tokens (15 min) plus opaque, rotated DB refresh tokens (7 d). Three roles: `admin` (global super-admin), `tenant_admin`, `user`. Users belong to tenants, and tenant 1 "Distributor" is seeded.
An embedded OAuth 2.1 server (open Dynamic Client Registration (DCR), PKCE S256, consent page, HMAC session cookie) issues the same JWTs for a minimal JSON-RPC MCP server at `/mcp`. That server has 10 read tools, and each one dispatches back through the Hono app.
Tenant isolation is enforced only for projects, project-groups and bom-entries reads. Floorplans, placements and areas are **not tenant-scoped**, which is the largest gap. Infra: one Docker image serves both API and SPA, uses SQLite plus local `uploads/`, and is configured through env or a `.env` file.

---

## Entities & fields

| Entity | Table | Fields (type, constraints) | Source |
|---|---|---|---|
| Tenant | `tenants` | `id` INTEGER PK AI; `name` TEXT NOT NULL, UNIQUE (idx_tenants_name); `is_distributor` INT 0/1 default 0; `is_active` INT 0/1 default 1; `created_at` DATETIME default now. Seed row: `(1,'Distributor',1,1)` | `backend/src/scripts/migrate.ts:740-752` |
| User | `users` | `id` PK; `email` TEXT UNIQUE NOT NULL (case-sensitive, no COLLATE NOCASE); `password_hash` TEXT NOT NULL (bcrypt, 10 rounds); `role` CHECK IN (`admin`,`tenant_admin`,`user`) default `user`; `created_at`; `full_name` TEXT NULL; `tenant_id` INT NOT NULL default 1 (**no FK to tenants**); `is_active` INT NOT NULL default 1 | `migrate.ts:755-775` |
| RefreshToken | `refresh_tokens` | `id` PK; `user_id` INT NOT NULL FK users(id) (**no ON DELETE CASCADE** after the later rebuild); `token_hash` TEXT UNIQUE (SHA-256 hex of the raw token); `expires_at`; `revoked_at` NULL; `created_at` | `migrate.ts:271-284`, `:544-559` |
| OAuthClient | `oauth_clients` | `id` TEXT PK (32 hex chars = 16 random bytes); `client_secret` TEXT NULL (SHA-256 hex of the raw secret); `redirect_uris` TEXT (JSON array); `client_name` NULL; `created_at` | `backend/migrations/038_oauth_clients.sql`, `repositories/oauth-client.ts` |
| OAuthAuthCode | `oauth_auth_codes` | `code` TEXT PK (64 hex chars = 32 bytes); `client_id` FK CASCADE; `user_id` FK CASCADE; `redirect_uri`; `code_challenge`; `scope` NULL; `expires_at` (TTL 60 s); `consumed_at` NULL | same, `repositories/oauth-code.ts:26` |
| Migrations | `migrations` | `id`, `name` UNIQUE, `applied_at` | `migrate.ts:14-23` |
| JWT payload | — | `sub` (user id as string), `email`, `role`, `tenantId` (number), `iat`, `exp` | `services/jwt.ts:9-16` |
| OAuth session cookie | — | `oauth_session=<b64url(JSON{uid,exp})>.<b64url(HMAC-SHA256(JWT_SECRET))>`, TTL 3600 s | `services/oauth/session-cookie.ts` |
| Frontend `User` | — | `id, email, full_name, role, tenantId, tenantName, tenant_id?, is_active?, created_at` | `frontend/src/types/index.ts:13` |

User API projections never include `password_hash`. Only `findByEmail` does `SELECT *` (`repositories/user.ts:49`).

---

## API endpoints

Access levels used below: Pub = no auth. JWT = `authMiddleware` (Bearer). TA = tenant_admin or admin. A = admin. Opt = optional auth.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | Pub | `{status:'ok',timestamp,version:'0.1.0'}` (`main.ts:61`) |
| GET | `/api` | Pub | API info JSON (`main.ts:70`) |
| GET | `/` | Pub | API info, only when `../frontend/dist` is missing (`main.ts:246`) |
| GET | `/api/*` (unmatched) | Pub | 404 `{error:'Not found'}` (`main.ts:142`) |
| POST | `/api/auth/login` | Pub + login rate limit | body `{email (email), password (min 6)}` (`routes/auth.ts:35`) |
| POST | `/api/auth/logout` | JWT | revokes **all** of the user's refresh tokens (`auth.ts:96`) |
| POST | `/api/auth/logout-all` | JWT | identical behaviour (`auth.ts:113`) |
| POST | `/api/auth/refresh` | Pub + refresh rate limit | body `{refreshToken}` (`auth.ts:141`) |
| GET | `/api/auth/me` | JWT | (`auth.ts:192`) |
| PUT | `/api/auth/me` | JWT | `{full_name? 1..255, email? email, password? min 8}` (`auth.ts:222`) |
| POST | `/api/users` | TA | `{email, full_name?, password min 8, role?, tenant_id?}` (`routes/users.ts:35`) |
| GET | `/api/users` | TA | `?tenantId=` filter, honoured for admin only (`users.ts:79`) |
| PUT | `/api/users/:id` | TA | **no Zod validation** (`users.ts:93`) |
| DELETE | `/api/users/:id` | TA | (`users.ts:168`) |
| GET | `/api/tenants` | A | (`routes/tenants.ts:11,14`) |
| GET | `/api/tenants/:id` | A | (`tenants.ts:20`) |
| POST | `/api/tenants` | A | `{name, is_distributor?}` (`tenants.ts:32`) |
| PUT | `/api/tenants/:id` | A | `{name?, is_active?, is_distributor?}` (`tenants.ts:52`) |
| DELETE | `/api/tenants/:id` | A | (`tenants.ts:71`) |
| GET | `/api/items`, `/api/items/:id/variants` | Opt | public catalog reads. `include_inactive` is honoured only for admin (`routes/items.ts:45,499`) |
| POST | `/oauth/register` | Pub (no rate limit) | DCR (`routes/oauth.ts:20`) |
| GET | `/oauth/authorize` | cookie | (`oauth.ts:44`) |
| POST | `/oauth/token` | client auth (form-encoded) | `authorization_code` and `refresh_token` grants (`oauth.ts:105`) |
| GET | `/oauth/consent` | cookie | HTML consent page (`routes/oauth-consent.ts:22`) |
| POST | `/oauth/consent` | cookie | form `action=allow\|deny` (`oauth-consent.ts:63`) |
| GET | `/.well-known/oauth-authorization-server` | Pub | (`routes/well-known.ts:6`) |
| GET | `/.well-known/oauth-protected-resource` | Pub | (`well-known.ts:10`) |
| POST | `/mcp` | JWT (with `WWW-Authenticate`) | JSON-RPC 2.0 (`routes/mcp.ts:21-46`) |
| GET | `/uploads/*` | **Pub** | static files, path-traversal guarded (`main.ts:147`) |
| OPTIONS | `/uploads/*` | Pub | 204 with CORS `*` (`main.ts:209`) |
| GET | `*` | Pub | serveStatic for `../frontend/dist`, then SPA `index.html` fallback (`main.ts:228-239`) |

Other routers, covered in other inventories, are mounted under `/api`: categories, item-types, items, projects, floorplans, placements, currency, settings, areas, project-groups, bom-entries. Every one of their endpoints requires JWT. Catalog mutations require A. Floorplans, placements and areas have no role check and no tenant check.

---

## Env & deployment

| Var | Default | Notes / source |
|---|---|---|
| `JWT_SECRET` | **required**: startup throws if undefined. No length or emptiness check | `config/env.ts:96`. Also the HMAC key for the OAuth session cookie (`session-cookie.ts:8`) |
| `PORT` | 8000 | parseInt, throws on NaN (`env.ts:94`) |
| `DATABASE_URL` | `./data/database.sqlite` | used verbatim as a file path, relative to **cwd** (`env.ts:95`, `database.ts:13`) |
| `UPLOAD_DIR` | `./uploads` | `./` and `../` resolve relative to the **backend root**, not cwd (`env.ts:81-91`) |
| `CORS_ORIGIN` | `http://localhost:5173` | used only when `NODE_ENV=production` (`main.ts:40`) |
| `NODE_ENV` | `development` | `development\|production\|test`, not validated |
| `TRUSTED_PROXY` | `false` | `'true'` enables X-Forwarded-For for rate limiting (`env.ts:100`) |
| `PUBLIC_BASE_URL` | unset | read directly via `Deno.env` in `utils/public-url.ts:14`. Not part of the `env` object |
| `VITE_API_URL` (frontend) | `/api` | `frontend/src/services/api.ts:6` |
| `OPENSPEC_TELEMETRY` | root `.env.example` | dev tooling only |

- `.env` loading (`env.ts:6-43`): the first existing file wins, in this order: `backend/.env`, repo-root `.env`, `cwd/.env`. Format is `KEY=VALUE`, with `#` comments and surrounding quotes stripped. **Real env vars win, except when they are the empty string**, which the file overrides (`if (!Deno.env.get(key))`).
- Startup (`main.ts:259-313`) runs these steps in order:
  1. `runMigrations()` (exit(1) on failure).
  2. `runBomImageMigration()` (non-fatal).
  3. `seedAdmin()`, which creates `admin@snapflow.com` with a random 12-character password printed to the log, but only if no user with role `admin` exists.
  4. `cleanupExpiredTokens()` and `oauthCodeRepository.deleteExpired()`, both immediately and then hourly.
  5. `Deno.serve` on `0.0.0.0:PORT`, passing `remoteAddr` into `c.env` so rate limiting can use it.
- Migrations: an inline array in `scripts/migrate.ts`. Each runs in its own transaction and is recorded by name. FKs are turned OFF for migrations `033`/`036`/`037`. `backend/migrations/*.sql` are partial mirrors (038 is duplicated inline).
- Dockerfile (2 stages):
  - Stage 1 is `node:20-alpine`, which builds the frontend.
  - Stage 2 is `denoland/deno:alpine` with python3/make/g++ for bcrypt. It writes `backend/.env` at build time with `NODE_ENV=production, PORT=8000, JWT_SECRET=$ARG, DATABASE_URL=./data/database.sqlite, UPLOAD_DIR=./uploads, CORS_ORIGIN=*`, then runs `deno install --allow-scripts=npm:bcrypt` and `deno cache`.
  - Exposes 8000. `HEALTHCHECK` fetches `/health`. CMD is `deno run --allow-all src/main.ts` in `/app/backend`.
- docker-compose: service `snapflow`, image `ghcr.io/kingkill85/snap-flow:latest`, port `8000:8000`. Volumes `snapflow_data:/app/backend/data` and `snapflow_uploads:/app/backend/uploads`. Env: the same as the Dockerfile plus `PUBLIC_BASE_URL`. `restart: unless-stopped`, with a healthcheck.
- CI: `.github/workflows/docker-build.yml` generates `JWT_SECRET=$(openssl rand -base64 32)` as a **build arg** and pushes to GHCR. `tests.yml` uses a fixed test secret.
- Admin scripts:
  - `scripts/create-admin.ts`: `admin@snapflow.local` / `admin123`, raw SQL, tenant defaults to 1, skipped if the email exists.
  - `scripts/reset-admin.ts`: `admin@snapflow.com`, resets the password to `admin123` and forces role admin, or creates the user.
  - `scripts/seed-admin.ts`: auto-runs at startup, as above.
  - `scripts/seed.ts`: `admin@snapflow.com` / `admin123`.
  - Root `gen-hash.ts`: prints a bcrypt hash of `admin123`.
  - `backend/test-login.ts`: compares a hard-coded hash.
- Out of scope: `tools/neo_dev_webhook/` is Python dev-automation tooling (a GitHub webhook receiver plus a "Hermes" kanban task and phase-label reconciler used for the AI dev pipeline), not part of the app.

---

## Acceptance criteria

### A. Password & tokens
1. Passwords are hashed with bcrypt at cost 10 (sync API) and verified with `compareSync` (`services/password.ts:3-17`).
2. The access token is a JWT, HS256, signed with `JWT_SECRET`. Claims are `sub`=String(userId), `email`, `role`, `tenantId`, `iat`, and `exp`=iat+900 s (`services/jwt.ts:5,19-44`).
3. Token verification uses djwt `verify`, so an expired or bad-signature token is rejected. iss and aud are not checked (`jwt.ts:49-58`).
4. A refresh token is 32 random bytes, standard base64 (with `+/=`). Only its SHA-256 hex is stored. It expires after 7 days (`services/refresh-token.ts:9,25-59`).
5. A refresh token is valid only when its hash exists, `expires_at` is in the future, and `revoked_at` is NULL (`refresh-token.ts:65-97`).
6. An hourly cleanup deletes refresh tokens that are expired **or revoked at any time** (`refresh-token.ts:131-139`, `main.ts:290-295`).

### B. Login / refresh / me / logout
7. Login with an unknown email returns 401 `Invalid email or password`. A wrong password returns the same 401 (`routes/auth.ts:40-49`).
8. Zod validates the login body: email must be valid and password at least 6 characters, otherwise 400 (zValidator default) (`auth.ts:27-30`).
9. A correct password with an inactive user returns 403 `Account disabled - contact your administrator`. The check runs after the password check (`auth.ts:52-54`).
10. A correct password with a missing or inactive tenant returns 403 with the same message (`auth.ts:57-60`).
11. A successful login returns 200 with `{data:{user:{id,email,full_name,role,tenantId,tenantName},accessToken,refreshToken},message:'Login successful'}` (`auth.ts:74-88`).
12. A successful login also sets `Set-Cookie: oauth_session=…; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600` (`auth.ts:68-72`).
13. Refresh with an unknown, expired or revoked token returns 401 `Invalid or expired refresh token` (`auth.ts:146-150`).
14. Refresh rotates the token: the presented token is revoked **before** the user and tenant checks. A missing user returns 404 `User not found`. An inactive user or tenant returns 403 (`auth.ts:153-170`).
15. A successful refresh returns `{data:{accessToken,refreshToken},message:'Token refreshed successfully'}`. Reusing the old refresh token afterwards returns 401 (`auth.ts:172-184`; test `auth-security_test.ts`).
16. `GET /auth/me` returns `{id,email,full_name,role,tenant_id,tenantId,tenantName ('Unknown' if the tenant is missing),created_at}`. A deleted user returns 404 (`auth.ts:192-219`).
17. `PUT /auth/me`: an email already used by another user returns 400 `Email already in use`. An empty update returns 400 `No fields to update`. A password under 8 characters returns 400. The response is `{id,email,full_name,role,created_at}` with no tenant fields (`auth.ts:222-270`).
18. `POST /auth/logout` and `/auth/logout-all` both revoke every active refresh token of the user, including OAuth/MCP refresh tokens. Access tokens stay valid until they expire. The `oauth_session` cookie is not cleared (`auth.ts:96-127`).
19. Any missing or non-`Bearer ` Authorization header returns 401 `Unauthorized - No token provided`. A bad token returns 401 `Unauthorized - Invalid token` (`middleware/auth.ts:12-29`).
20. `authMiddleware` sets `userId` (int), `userEmail`, `userRole` and `tenantId` from the JWT claims, with **no DB lookup**. Role, tenant and is_active changes therefore take effect only after the token is reissued (≤15 min) (`auth.ts:20-24`).
21. `optionalAuthMiddleware` populates identity when the token is valid. When the token is invalid it silently continues as anonymous (`auth.ts:35-51`).
22. `tenantAdminMiddleware` allows `tenant_admin` and `admin` and returns 403 `Forbidden - Admin access required` for anyone else. `adminMiddleware` allows only `admin` (`auth.ts:57-79`).

### C. Rate limiting
23. Rate limiting uses an in-memory fixed window keyed by client id. Login allows 10 requests per 5 minutes and refresh allows 10 per minute (`middleware/rate-limit.ts:139-149`).
24. Every allowed response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (epoch seconds) (`rate-limit.ts:116-128`).
25. Requests over the limit get 429 `{error:'Too many requests',message:'Rate limit exceeded. Try again in N seconds.'}` with `Retry-After` (`rate-limit.ts:102-111`).
26. The client id is the transport `remoteAddr.hostname`, or `'no-ip'` when absent. When `TRUSTED_PROXY=true`, it is instead the rightmost non-private IP in `X-Forwarded-For`, falling back to the last entry (`rate-limit.ts:39-65`).
27. Expired entries are purged every 5 minutes. `clearRateLimitStore()` exists for tests (`rate-limit.ts:24-34,154`).

### D. Users (management)
28. `POST /users`: a duplicate email returns 400 `User with this email already exists`. A non-admin trying to create role `admin` returns 403 `Only admins can create admin users`. Role defaults to `user` (`users.ts:42-64`).
29. On create, the target tenant is the caller's tenant. Only an admin may override it with `tenant_id`; a `tenant_id` sent by a tenant_admin is silently ignored. The response is 201 `{data:user,message:'User created successfully'}` (`users.ts:48-71`).
30. `GET /users`: a tenant_admin sees only their own tenant. An admin sees all users, or only tenant X with `?tenantId=X`. Results are ordered by `created_at DESC` and fields are `id,email,full_name,role,tenant_id,is_active,created_at` (`users.ts:21-32,79-90`, `repositories/user.ts:14-26`).
31. `PUT /users/:id` validation and existence: a non-numeric id returns 400 `Invalid ID` and a missing user returns 404 (`users.ts:93-106`).
32. `PUT /users/:id` tenant boundary: a non-admin editing a user in another tenant gets 403 `Forbidden - Cannot edit users from other tenants` (`users.ts:108-111`).
33. `PUT /users/:id` email: an email used by another user returns 400 `Email already in use` (`users.ts:119-125`).
34. `PUT /users/:id` password: a password is re-hashed. There is **no minimum length** here (`users.ts:127-129`).
35. `PUT /users/:id` role: only `admin|tenant_admin|user` are accepted, and anything else is silently ignored. Assigning `admin` as a non-admin returns 403 `Only admins can assign admin role` (`users.ts:131-137`).
36. `PUT /users/:id` tenant change: only an admin may set `tenant_id`; it is ignored for anyone else (`users.ts:139-141`).
37. `PUT /users/:id` deactivation: deactivating a user whose role is `admin` returns 403 `Cannot deactivate admin users` (`users.ts:143-149`).
38. `PUT /users/:id` with no applicable fields returns 400 `No fields to update` (`users.ts:151-153`).
39. `DELETE /users/:id` on your own account returns 400 `Cannot delete your own account`. A missing user returns 404. A non-admin deleting a user in another tenant gets 403. Success is 200 `{message:'User deleted successfully'}` (hard delete) (`users.ts:168-200`).

### E. Tenants
40. All `/api/tenants/*` routes require admin. A tenant_admin or user gets 403 on every route (`tenants.ts:11`; `tenants_test.ts`).
41. `GET /tenants` is ordered by name. `GET /tenants/:id` returns 404 `Tenant not found` when missing (`tenants.ts:14-29`, `repositories/tenant.ts:5`).
42. `POST /tenants`: an empty or non-string name returns 400 `Tenant name is required`. A duplicate trimmed name returns 409 `A tenant with this name already exists`. `is_distributor` is truthy-coerced to 1/0. Success is 201 `{data:tenant}` (`tenants.ts:32-49`).
43. `PUT /tenants/:id`: a missing tenant returns 404. `name` is trimmed, and `is_active` and `is_distributor` are passed through as sent. The response is `{data:updatedTenant}` (`tenants.ts:52-68`).
44. `DELETE /tenants/:id`: a missing tenant returns 404. A distributor tenant returns 403 `Cannot delete a distributor tenant`. A tenant with projects returns 400 `Cannot delete tenant with N project(s)…`. Otherwise the tenant's users are hard-deleted, then the tenant, returning `{message:'Tenant deleted successfully'}` (`tenants.ts:71-99`).
45. A deactivated tenant blocks login and refresh with 403 (see B10 and B14). It does **not** block existing access tokens or the OAuth refresh grant.

### F. Tenant isolation (data scoping)
46. Projects: when the caller is not admin, every project read, update and delete adds `tenant_id = caller.tenantId`. A project in another tenant appears as 404 (`repositories/project.ts:24,74,144,169`; `routes/projects.ts:23-34`).
47. An admin sees every tenant. With `?tenantId=X` (projects and users only) an admin is filtered to tenant X (`projects.ts:28-31`, `users.ts:26-29`).
48. Project creation defaults to the caller's tenant. Only an admin may set `tenant_id` on create or update; a non-admin's value is ignored (`projects.ts:180-185,241`).
49. Project-groups are scoped by `{role, tenantId}` from the JWT. There is no `?tenantId` override (`routes/project-groups.ts:12-17`).
50. Deleting a project or project group with role `user` returns 403 (`projects.ts:273`, `project-groups.ts:217`).
51. `GET /api/bom-entries/:id`: for a non-admin whose entry's project belongs to another tenant, the route returns 404 `BOM entry not found` (`routes/bom-entries.ts:24-33`).
52. **Gap (must be decided for v2):** `/api/floorplans*`, `/api/placements*`, `/api/areas*` and `/api/floorplans/:id/bom*` perform no tenant or ownership checks, so any authenticated user can read and mutate another tenant's data by id. `GET /api/floorplans` without `project_id` and `GET /api/placements` without `floorplan_id` return all rows from every tenant (`routes/floorplans.ts:29-64,93`, `placements.ts:48-111`, `areas.ts:32-66`). The comment at `main.ts:78-80` ("single workspace by design") is a leftover from before multi-tenancy.
53. The catalog (categories, item types, items, variants) is global and not tenant-scoped. Reads are open (some are public), and writes are admin-only.

### G. OAuth 2.1 server
54. `POST /oauth/register` accepts JSON `{redirect_uris: url[] (min 1), client_name?}`, plus any passthrough fields, which are ignored. It always generates a 32-byte base64url secret and stores its SHA-256 (`routes/oauth.ts:15-30`, `services/oauth/client-secret.ts`).
55. The register response is 201 `{client_id, client_secret (shown once), client_id_issued_at, redirect_uris, client_name, token_endpoint_auth_method:'client_secret_post', grant_types:['authorization_code','refresh_token'], response_types:['code']}` (`oauth.ts:32-41`).
56. `GET /oauth/authorize` checks run in order, each returning text/plain 400: `response_type≠code`, then missing `client_id`, `redirect_uri` or `code_challenge`, then `code_challenge_method≠S256`, then unknown client, then a `redirect_uri` that is not an exact member of the registered list (`oauth.ts:53-61`).
57. On `/oauth/authorize`, a missing or invalid `oauth_session` cookie gives a 302 to `/login?return_to=<encodeURIComponent(absolute request URL)>` (`oauth.ts:64-71`).
58. On `/oauth/authorize`, a valid cookie gives a 302 to `/oauth/consent?client_id&redirect_uri&code_challenge&state&scope`. `scope` defaults to `read` and `state` to `''` (`oauth.ts:73-79`).
59. `GET /oauth/consent`: with no cookie it redirects to login as in G57. An unknown client returns 400 `unknown client`, and an unregistered redirect returns 400 `bad redirect_uri`. Otherwise it renders HTML ("Authorize {client_name ?? 'an MCP client'}… as {email}") with every value HTML-escaped and hidden fields plus Allow and Deny buttons (`oauth-consent.ts:22-61`).
60. `POST /oauth/consent`: with no cookie it returns 401 `not authenticated`. A bad client or redirect returns 400 (`oauth-consent.ts:63-78`).
61. `POST /oauth/consent` with `action≠allow` gives a 302 to `redirect_uri?error=access_denied[&state]` (`oauth-consent.ts:80-85`).
62. `POST /oauth/consent` with allow creates a code (TTL 60 s, bound to client, user, redirect_uri, code_challenge and scope) and gives a 302 to `redirect_uri?code=…[&state]` (`oauth-consent.ts:87-96`).
63. Session cookie: the HMAC must verify with `JWT_SECRET` and `exp` must be in the future, otherwise the user id is null (`session-cookie.ts:37-56`).
64. `POST /oauth/token` reads the body as `application/x-www-form-urlencoded` or multipart form data (`oauth.ts:106`).
65. Client authentication for the authorization_code grant: a missing `client_id` returns 401 `invalid_client`. An unknown client also returns 401. A client that has a secret must send `client_secret`; a missing or invalid one returns 401 `invalid_client`. The secret comparison is constant-time-ish on the SHA-256 hex (`oauth.ts:82-103`, `oauth-client.ts:55-60`).
66. Authorization_code grant field checks: any missing `code`, `redirect_uri`, `client_id` or `code_verifier` returns 400 `invalid_request` (`oauth.ts:115-122`).
67. Authorization_code grant code checks: the code must be unconsumed and unexpired and is consumed atomically (single use), otherwise 400 `invalid_grant` (`code invalid/expired/reused`) (`oauth.ts:123-126`).
68. Authorization_code grant binding checks: a mismatched `client_id` or `redirect_uri` returns 400 `invalid_grant`. A PKCE failure, where base64url(SHA-256(verifier)) ≠ challenge, also returns 400 `invalid_grant`. A deleted user returns 400 `invalid_grant` (`user gone`) (`oauth.ts:127-139`, `services/oauth/pkce.ts`).
69. The authorization_code success response is `{access_token (same JWT as app login), token_type:'Bearer', expires_in:900, refresh_token (same table as app), scope: code.scope ?? 'read'}` (`oauth.ts:141-150`).
70. Refresh_token grant client check: `client_id` is optional. If it is present, the same client authentication as G65 applies (`oauth.ts:154-157`).
71. Refresh_token grant token check: a missing token returns 400 `invalid_request`. An invalid, expired or revoked token returns 400 `invalid_grant` (`oauth.ts:159-164`).
72. Refresh_token grant success: the presented token is rotated (revoked) and the response returns a new access token and refresh token with `scope:'read'`. The user's `is_active` and tenant activity are **not** checked (`oauth.ts:166-175`).
73. Any other `grant_type` returns 400 `{error:'unsupported_grant_type'}` (`oauth.ts:178`).
74. Auth-server metadata: `issuer`=base, `authorization_endpoint`, `token_endpoint` and `registration_endpoint` under base, `response_types ['code']`, `grant_types ['authorization_code','refresh_token']`, `code_challenge_methods ['S256']`, `token_endpoint_auth_methods ['none','client_secret_post']`, `scopes ['read']` (`services/oauth/metadata.ts:20-32`).
75. Protected-resource metadata: `{resource: base+'/mcp', authorization_servers:[base], bearer_methods_supported:['header'], scopes_supported:['read']}` (`metadata.ts:34-41`).
76. The base URL is `PUBLIC_BASE_URL` with its trailing slash stripped. If that is unset, it is `X-Forwarded-Proto` plus (`X-Forwarded-Host` or `Host`), using the first comma value when both are present. Otherwise it is the request URL origin (`utils/public-url.ts`).
77. Expired **or consumed** auth codes are deleted at startup and then hourly (`oauth-code.ts:50-56`, `main.ts:291-294`).

### H. MCP server
78. `POST /mcp` without a `Bearer` header returns 401 `{error:'unauthorized'}` with `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource"`. An invalid or expired JWT returns 401 with the same header (`routes/mcp.ts:21-39`).
79. The transport is plain JSON-RPC 2.0 over a single POST with a JSON response. There is no SSE, no GET or DELETE, no `Mcp-Session-Id`, and no batching (`mcp.ts:41-46`).
80. `initialize` returns `{protocolVersion:'2024-11-05', capabilities:{tools:{}}, serverInfo:{name:'snapflow-mcp',version:'0.1.0'}}` (`services/mcp/server.ts:43-53`).
81. `tools/list` returns the 10 tools with `{name, description, inputSchema}`. The schema is a JSON Schema object with `additionalProperties:false`; numbers are `integer` with min and max taken from Zod (`server.ts:54-66`, `zod-to-json-schema.ts`).
82. `tools/call` errors: missing params give `-32602 'missing params'`. An unknown tool gives `-32601 'unknown tool: X'`. Zod failure gives `-32602 <zod message>`. An unknown method gives `-32601 'unknown method: X'` (`server.ts:67-84`).
83. A successful tool call returns `result: {content:[{type:'text'|'image', text?|data?,mimeType?}], isError?}`. When a backend call fails, the result is `isError:true` with text `Failed to … (HTTP <status>): <json body>` (tools/*).
84. Tools call `/api/...` in-process via `app.fetch` with the caller's Bearer token, so every middleware, role check and tenant scope applies (`services/mcp/dispatcher.ts`).
85. Tool `list_projects` takes `{query?: string}` and calls `GET /api/project-groups?search=query`. It returns the `data` JSON (`tools/list-projects.ts`).
86. Tool `get_project` takes `{project_id: int>0}` and calls `GET /api/project-groups/:id` (`tools/get-project.ts`).
87. Tool `get_version_total` takes `{version_id: int>0}` and calls `GET /api/projects/:id/total` (`tools/get-version-total.ts`).
88. Tool `search_items` takes `{query?, category_id? int>0, type_id? int>0, limit? 1..100}` and calls `GET /api/items?search&category_id&type_id&limit`. The backend default limit is 20 (`tools/search-items.ts`).
89. Tool `list_floorplans` takes `{version_id: int>0}` and calls `GET /api/floorplans?project_id=` (`tools/list-floorplans.ts`).
90. Tool `get_floorplan_bom` takes `{floorplan_id: int>0}`. It fetches four endpoints in parallel: `/floorplans/:id/bom`, `/areas?floorplan_id`, `/floorplans/:id` and `/placements?floorplan_id`, then `/projects/:project_id` (`tools/get-floorplan-bom.ts`).
91. `get_floorplan_bom` adds `area_name` and `placements[]` to each group's `mainEntry`. Placements are collected across `bomEntryIds`, and each carries `{placement_id,x,y,width,height,rotation,area_id,area_name?,area_box?}`. Children get only `area_name` (`get-floorplan-bom.ts:79-101,201-213`).
92. `get_floorplan_bom` also adds `floorplan_name`, `version_name`, `canvas{image_path,width,height,coordinate_system:'image-pixel, origin top-left of canvas, rotation in degrees clockwise'}` (only for a safe relative path; width and height come from the PNG or JPEG header) and `areas[{id,name,x,y,width,height}]`. A failure of the BOM call is the only hard error (`get-floorplan-bom.ts:134-235`, `image-dimensions.ts`).
93. Tool `list_areas` takes `{floorplan_id: int>0}` and calls `GET /api/areas?floorplan_id=` (`tools/list-areas.ts`).
94. Tool `get_invoice_calculation` takes `{version_id: int>0}` and calls `GET /api/projects/:id/invoice-calculation` (`tools/get-invoice-calculation.ts`).
95. Tool `get_item_picture` takes `{bom_id?|variant_id?|item_id?}` and requires exactly one, otherwise `isError` `'Pass exactly one of …'` (`tools/get-item-picture.ts:136-142`).
96. `get_item_picture` with `bom_id` resolves via `GET /api/bom-entries/:id`, which is tenant-checked, and uses its `picture_path` (`get-item-picture.ts:50-74`).
97. `get_item_picture` with `variant_id` or `item_id` reads the repository **directly**. `item_id` uses the first active variant that has an image (`get-item-picture.ts:76-128`).
98. `get_item_picture` returns an image block with base64 bytes and a mime type from the extension (jpg/jpeg/png/webp/gif, else octet-stream), plus a text note: "loaded for your analysis only. The user cannot see it" (`get-item-picture.ts:32-47`).
99. Tool `get_floorplan_image` takes `{floorplan_id}`, calls `GET /api/floorplans/:id`, then reads `image_path` from disk and returns an image block plus a text block. A missing `image_path` gives `isError` (`tools/get-floorplan-image.ts`).
100. `get_project_total` exists but is **not registered** (dead code) (`tools/get-project-total.ts`).

### I. Uploads, file storage, static
101. `uploadMiddleware` never rejects on its own. It sets `uploadResult {success, filePath?, originalName?, error?}` and `formData` on the context and always calls `next()`. The route decides the response (`middleware/upload.ts:35-158`).
102. Without multipart, `uploadResult` is `{success:false,error:'No file uploaded'}`. With no file in the field (default `image`), the error is `No <field> file provided` (`upload.ts:56-73`).
103. Image mode accepts MIME `image/jpeg|jpg|png|webp` only, otherwise `Invalid file type…`. Files over 5 MB fail with `File too large. Maximum size: 5MB`. Magic bytes must match JPEG FFD8FF, PNG 89504E47, or WebP RIFF…WEBP, otherwise `Invalid file format` (`upload.ts:9-19,76-110`, `utils/magic-bytes.ts`).
104. Excel mode (`skipValidation:true`) checks neither MIME nor size. Magic bytes must be XLSX `PK\x03\x04` or XLS `D0CF11E0` (`upload.ts:76,104`, `magic-bytes.ts:27-35`).
105. With `maxImageWidth`, the image is resized through `processImageSafe`. If processing fails, the original bytes are saved (`upload.ts:116-134`).
106. Floorplans are resized to 1920 px and item variants to 1200 px (`floorplans.ts:67,125`, `items.ts:532,615`).
107. Saved file naming: the sanitized original name (`<>"|?*` removed, `..` removed, `/` and `\` replaced by `-`) is turned into `<Date.now()>-<6 base36 chars>.<original ext>` under `UPLOAD_DIR/<subdir>/`. The stored path is relative, `<subdir>/<file>` (`services/file-storage.ts:35-70`).
108. `copyFile` falls back to returning the **source** path on any failure (`file-storage.ts:79-114`).
109. `GET /uploads/<path>`: a path that resolves outside `UPLOAD_DIR` returns 404 `File not found`, including URL-encoded traversal. A missing file returns 404 and other errors return 500 (`main.ts:147-207`).
110. `GET /uploads` response headers: content type is jpeg/png/webp by extension, else octet-stream. Also set: `Content-Length`, `Access-Control-Allow-Origin: *`, `Cache-Control: public, max-age=31536000, immutable`, `ETag "<mtime36>-<size36>"` and `Last-Modified`. A matching `If-None-Match` returns 304 (`main.ts:161-199`).

### J. CORS
111. A request without an `Origin` header gets ACAO `*` (`main.ts:38`).
112. In production, an origin equal to `CORS_ORIGIN` is echoed back. If `CORS_ORIGIN` is `*`, the response is `*`. Otherwise `CORS_ORIGIN` is returned, so the browser blocks the mismatched origin (`main.ts:40-52`).
113. In development every origin is reflected (`main.ts:55`).
114. Credentials are always enabled (`credentials: true`) (`main.ts:57`).

### K. Frontend auth
115. Tokens are stored in `localStorage` under the keys `accessToken` and `refreshToken` (`frontend/src/services/auth.ts:22-43`).
116. The Axios request interceptor adds `Authorization: Bearer`. It deletes Content-Type for FormData and otherwise sets JSON (`services/api.ts:34-56`).
117. On a 401 from any URL except `/auth/login` and `/auth/refresh`, the response interceptor refreshes once. Concurrent 401s queue behind a single refresh and are then retried with the new token (`api.ts:59-144`).
118. Refresh failure handling: with no refresh token, or when the refresh itself returns 401, the client clears tokens and dispatches the `auth:logout` window event. Network errors (no response) never log the user out (`api.ts:79-138`).
119. On mount, `AuthContext` does the following:
    1. With only a refresh token stored, it refreshes first.
    2. It then calls `/auth/me`.
    3. It clears tokens only on a 401; other errors leave the tokens but set the user to null.
    (`context/AuthContext.tsx:27-75`)
120. `ProtectedRoute` shows a spinner while loading. Unauthenticated users are sent to `/login`. `requireAdmin` sends non-admins to `/`. `requireTenantAdmin` sends anyone who is not admin or tenant_admin to `/` (`components/auth/ProtectedRoute.tsx`).
121. Route guards: `/settings/users` requires tenant admin and `/settings/tenants` requires admin. Catalog pages need only authentication (`App.tsx:48-73`).
122. The Header shows "User Management" to tenant_admin and admin, and "Tenants" only to admin. It shows `tenantName` for non-admins (`components/layout/Header.tsx:27-28,126,167`).
123. After login, Login navigates to `return_to` only when it starts with `/`, and otherwise to `/` (`pages/Login.tsx:29-35`).
124. Profile page: the password is optional. When given it must be at least 6 characters (client check) and match the confirmation. Only changed fields are sent (`pages/Profile.tsx:32-50`).
125. User form modal:
    - Edit mode shows `user` with the role options User, Tenant Admin, and Admin (admin callers only).
    - The tenant select is shown to admins only.
    - The Active switch is hidden for admin targets.
    - The password is required on create and optional on edit.
    (`components/users/UserFormModal.tsx`)
126. Tenant page: Distributor and Partner badges plus Active and Inactive badges. Delete is disabled for distributor tenants and calls `DELETE /tenants/:id`. The form edits `name`, `is_distributor` and `is_active` (`pages/settings/TenantManagement.tsx`, `components/settings/TenantFormModal.tsx`).

---

## Edge cases & quirks
- `logout` and `logout-all` are identical. Logging out of the web UI also kills every MCP connector refresh token for that user.
- `authMiddleware` wraps `await next()` in try/catch. A downstream exception that propagates could therefore surface as 401 `Invalid token`, which would trigger a frontend refresh and retry loop. Hono normally routes handler errors to `onError`; verify in v2.
- Email lookups are case-sensitive, so `Admin@x` and `admin@x` are different users.
- The minimum password length is inconsistent: 6 on login and the Profile UI, 8 on `PUT /auth/me` and `POST /users`, and none on `PUT /users/:id`. A Profile change of 6–7 characters fails server-side with 400.
- `PUT /auth/me` returns no `tenantId` or `tenantName`. AuthContext replaces `user` with that response, so `tenantName` disappears from the header until reload.
- A JWT `email` or `role` change is not reflected until refresh (≤15 min). Changing an email or password does not revoke existing tokens.
- An admin's `?tenantId=abc` parses to NaN, which returns an empty list.
- `POST /users` by an admin with a non-existent `tenant_id` creates an orphan user, because there is no FK. That user's login then returns 403.
- `PUT /tenants/:id` with a non-string `name` throws (500). Renaming to an existing name violates the unique index, giving an unhandled 500.
- Several tenants can be flagged `is_distributor`. `findDistributor()` returns the first one.
- In `POST /project-groups/:id/versions`, an admin creating a version in another tenant's group stamps the new version with the **admin's** tenantId (`project-groups.ts:191`).
- OAuth `Secure` cookie: over plain-HTTP deployments (except localhost) the browser drops it, so OAuth requires HTTPS.
- The `oauth_session` cookie is issued only at an explicit login and lasts 1 h. A user who is logged in through localStorage tokens but has no fresh cookie is bounced to `/login`.
- The OAuth `scope` parameter is accepted and echoed but never enforced. The refresh grant always reports `read`.
- The metadata advertises `token_endpoint_auth_methods: ['none', …]`, but DCR always issues a secret. Public clients are possible only through a direct DB insert.
- MCP `notifications/*` messages, which have no id, receive a JSON-RPC error body with HTTP 200 instead of 202. The `protocolVersion` is fixed regardless of what the client requests.
- JSON parse errors on `/mcp`, and form parse errors on `/oauth/token` with a JSON body, give unhandled 500s.
- `DATABASE_URL` is resolved relative to cwd, while `UPLOAD_DIR` is resolved relative to the backend root.
- In development, Vite proxies only `/api` and `/uploads`. `/oauth`, `/mcp` and `/.well-known` are only reachable on :8000.
- The `/uploads` content-type map lacks gif, but the MCP tools map gif.
- After resizing, the saved extension still comes from the original filename. If `processImageSafe` changes the format, the extension and the bytes can mismatch.
- The comment on `DELETE /tenants` mentions "soft delete otherwise", but the code returns 400 instead.
- `seedAdmin` checks only "any admin exists". If every admin is renamed or demoted, a new `admin@snapflow.com` is created on restart, or the insert fails if that email already exists as a non-admin.
- `users.ts` comment "PUT /users/:id - Update user (admin only)" is wrong: tenant_admin is allowed.

---

## Suspected bugs / security gaps / dead code

**Critical / high**
1. **Cross-tenant IDOR**: floorplans, placements, areas, floorplan BOM, bom-entry mutations and update-from-catalog have no tenant scoping and no role check. A `user` from tenant B can read, modify and delete tenant A's floorplans. MCP tools `list_floorplans`, `list_areas`, `get_floorplan_bom` and `get_floorplan_image` inherit this. `tests/mcp/tenant_isolation_test.ts` covers projects only (`routes/floorplans.ts`, `placements.ts`, `areas.ts`).
2. **JWT_SECRET baked into the public image**: CI generates the secret as a Docker build arg and writes it into `backend/.env` inside a pushed GHCR image (`Dockerfile:37-40`, `docker-build.yml:53-69`). Anyone who pulls the image can forge admin JWTs for every deployment that does not override `JWT_SECRET`. A compose `JWT_SECRET=` left empty is overridden by the baked file value (`env.ts:28`). README claims it is "Auto-generated if not set".
3. **OAuth refresh grant ignores deactivation**: deactivated users and tenants keep minting tokens through `/oauth/token` `grant_type=refresh_token` indefinitely (`oauth.ts:153-175`). The authorization_code grant also skips the is_active and tenant checks.
4. **Scope not enforced**: the "read-only" MCP connector receives a full-privilege JWT that is valid on every write endpoint (and admin endpoints for an admin). README calls it read-only.
5. **tenant_admin can take over or demote admins in the same tenant**: `PUT /users/:id` lets a tenant_admin change an admin's password or email, set `role:'user'`, or `DELETE` them. Only *assigning* the admin role and *deactivating* an admin are blocked (`users.ts:108-149,188`). Admins live in tenant 1, so any Distributor tenant_admin is affected.
6. **Refresh tokens are not bound to a client**: any refresh token, including web-app tokens, can be redeemed at `/oauth/token` without a `client_id`. OAuth refresh tokens likewise work at `/api/auth/refresh`.
7. **Open DCR with no rate limit**: anyone can register clients with arbitrary `client_name` (consent-page phishing: "Authorize Claude.ai") and any URL scheme or host as the redirect. The table grows without bound.

**Medium**
8. **User delete likely fails (FK)**: `refresh_tokens.user_id` lost `ON DELETE CASCADE` (`migrate.ts:547`) while `PRAGMA foreign_keys=ON`. Deleting a user who still has non-cleaned refresh tokens should throw, giving a 500 from `DELETE /users/:id`. `DELETE /tenants/:id` is unhandled and would 500 after partial deletes. Tests only delete users who never logged in. Unverified (deno was not available locally).
9. **OAuth login return is broken**: the backend sends an absolute `return_to` (`oauth.ts:69`, `oauth-consent.ts:25`), and the frontend accepts only values starting with `/` (`Login.tsx:30`), so the user lands on `/`. Even a relative value would be pushed through the SPA router (`navigate`), which renders NotFound instead of hitting the backend `/oauth/authorize`. A frontend test expects a relative value and does not catch this. The flow works only if the user retries within 1 h of logging in.
10. **Shared rate-limit store**: login and refresh share one Map keyed by IP, so refresh calls consume the login budget and vice versa (`rate-limit.ts:15,87`).
11. **Proxy and private-IP handling**: behind a reverse proxy without `TRUSTED_PROXY`, every user shares one IP bucket (10 logins per 5 min globally). Compose does not set it.
12. **`isPrivateIp` is wrong**: the prefixes `172.2` and `172.3` also match public 172.200–172.255 and 172.3x ranges. IPv6 ULA and link-local are missing (`rate-limit.ts:67-73`).
13. **Logout does not clear `oauth_session`**: a logged-out browser can still authorize OAuth clients as that user for up to 1 h.
14. **Uploads are fully public** with guessable names (ms timestamp plus 6 base36 characters from `Math.random`). This includes uploaded Excel catalog files under `uploads/imports/` (prices) and customer floorplans. There is no `X-Content-Type-Options: nosniff` header.
15. **Excel uploads have no size limit** (`skipValidation` bypasses `maxSize`).
16. `POST /items/import-preview` uses image-mode upload with field `image` (`items.ts:989`), so a real Excel file is always rejected. The endpoint looks broken or dead (catalog inventory should confirm).
17. `get_item_picture` with `variant_id` or `item_id` bypasses HTTP authz and returns images of inactive variants. `get_floorplan_image` and `get_item_picture` read DB paths without the `isSafeRelativeStoragePath` check that `get_floorplan_bom` applies.
18. `seedAdmin` generates its password with `Math.random` (not a CSPRNG) and prints it to logs. `create-admin`, `reset-admin` and `seed.ts` use the hard-coded `admin123`.
19. `reset-admin.ts` and `seed.ts` create users without `tenant_id`, so the insert should fail on NOT NULL (`repositories/user.ts:61` passes undefined).
20. `JWT_SECRET` has no minimum length or emptiness check. The same key signs JWTs and the session cookie, and there is no key rotation.
21. CORS in development reflects any origin with `credentials:true`. A production `CORS_ORIGIN=*` combined with credentials is ineffective for credentialed requests. This is harmless today because auth uses Bearer headers.
22. Refresh-token reuse is not detected: revoked tokens are hard-deleted hourly and no token family is invalidated.
23. Login returns 403 "Account disabled" only after the password check passes, which reveals that the password is valid for disabled accounts (minor).

**Dead / stale code**
24. `tools/get-project-total.ts` is not registered. README still lists `get_project_total` and says "four tools" (there are 10).
25. `types/hono.d.ts` declares `userRole: 'admin'|'user'` and omits `tenantId`.
26. `UserRepository.findAll` is called with `role:'tenant_admin'` as a "force filtering" hack.
27. Frontend `userService.getById` calls `GET /api/users/:id`, which does not exist (404). `tenantService.deactivate` actually calls DELETE.
28. `CreateUserDTO.password` and `UpdateUserDTO.password` exist in models but are unused.
29. `tenantRepository` is exported as a singleton while routes construct `new TenantRepository()`.
30. Root `gen-hash.ts` imports `./src/services/password.ts`, a path that does not exist from the repo root, so the script is broken. `backend/test-login.ts` is a stray script.
31. The `backend/migrations/*.sql` files are partial duplicates of the inline migrations, and the 038 file header says "Migration 034".
32. `encodeBase64` (`utils/encoding.ts`) uses a spread over the byte array, which is fine for 32 bytes but would overflow the stack on large buffers. MCP uses `@std/encoding` instead.
