# 06 — Frontend shell, navigation, cross-cutting UX, test suites, docs

Scope: SnapFlow 1 frontend shell (`frontend/src`), the existing tests used as acceptance criteria, and requirements stated in docs. Paths are relative to the repo root (`/home/michael/Projects/github/kingkill85/snap-flow`) unless noted. FE = `frontend/src`.

## Summary

- SPA with React Router 6 (`FE/App.tsx`). One public route (`/login`). Everything else sits under `ProtectedRoute` → `Layout` (sticky header plus a `container` main). A catch-all 404 sits outside the layout.
- There are three roles: `admin` (global; shown as "Admin", called "distributor" in the spec), `tenant_admin` and `user`. The UI gates on role in `ProtectedRoute`, the header menus and inline `isAdmin`/`canEdit` flags on each page.
- Contexts: `ThemeProvider` → `AuthProvider` → `SyncProvider` → `BrowserRouter`. All three sit outside the router.
- Auth uses JWT access and refresh tokens in `localStorage`. An Axios interceptor refreshes once on 401 and queues concurrent 401s. A hard auth failure fires a `auth:logout` window event, which clears the user, and `ProtectedRoute` then redirects to `/login`.
- There is no toast or notification system: no toast library, and every page uses inline `<Alert>`. There is no i18n: all strings are English and hard-coded. Money always shows as `$` with `en-US` formatting. Dates are `de-DE` in one place and ISO elsewhere. The default local currency is `PKR`.
- There is almost no responsive design. Below `md` the header hides its nav with no mobile menu, and the configurator uses a fixed full-viewport layout with a fixed 400 px right panel.
- Test assets: 1 cucumber scenario (infrastructure tracer only). There are about 37 frontend Vitest files with roughly 250 cases, and 59 backend Deno test files with roughly 480 tests and steps. None of them is a real end-to-end business-flow test.
- Docs: `README.md` and `IMPLEMENTATION_PLAN.md` are badly out of date. They describe Excel proposals, a customers table and admin/user roles. The design specs in `docs/superpowers/specs/` are the most reliable statement of requirements.

## Pages & routes

| Route | Component | Guard | What it shows / does |
|---|---|---|---|
| `/login` | `FE/pages/Login.tsx` | public; no Layout/header | A centred card with the stacked logo (light and dark variants), "Welcome back", Email and Password fields (both HTML-required) and a "Sign in" button that changes to "Signing in..." with a spinner. Errors appear in a destructive Alert using the server message, or "Invalid email or password". On success it goes to `?return_to` if that starts with `/`, else to `/`. An already-authenticated user who visits it is **not** redirected. |
| `/` | `FE/pages/Home.tsx` | auth | Hero with the stacked logo and tagline "Smart home automation configurator and proposal generator". "Get Started" goes to `/projects` with `state.openCreateModal=true`, which auto-opens the New Project modal. "View Projects" goes to `/projects`. Three static feature cards (Upload Floorplans / Drag & Drop Items / Generate Proposals). The proposal card says "Excel", but the export is actually DOCX. |
| `/profile` | `FE/pages/Profile.tsx` | auth | Avatar letter, name and role label. Form: Full Name, Email (required), New Password and Confirm. Client checks: password at least 6 characters, passwords match, and "No changes to save" when nothing changed. Sends only the changed fields to `PUT /auth/me`. Shows a green success Alert "Profile updated successfully" and clears the password fields. |
| `/projects` | `FE/pages/projects/ProjectList.tsx` | auth | Title "Projects" and a "New Project" button (all roles). Search runs server-side with a 300 ms debounce and an inline spinner. The status filter runs client-side: Active (default), Completed, Cancelled, All. The table shows project groups with an expand chevron; clicking the row also toggles it. Columns: Project Number (`YYYY-MM-DD_Customer_Address`, UTC date), Customer, Tenant (admin only), Status (coloured icon and text), and actions Open (latest version) plus Edit and Delete group (hidden for `user`). Expanded rows list versions with name, date (`de-DE`) and Open/Copy/Edit/Delete, which are **not** role-gated. Modals: ProjectFormModal, CreateVersionModal, EditGroupModal, an **inline** Edit Version dialog, and ConfirmDeleteModal for both version and group. Sort is ascending by project-number string. |
| `/projects/:id` | `FE/pages/projects/ProjectDashboard.tsx`, wrapped in `ErrorBoundary` | auth | Full-viewport configurator (`fixed inset-0 top-12`). `ProjectHeader` is a back arrow plus project number, version name and customer. A read-only banner shows for role `user`. On the left: FloorplanTabs (rename, move left/right, delete, +) and `ConfiguratorCanvas`, or EmptyFloorplanState. On the right, a 400 px tabbed panel: Products (ItemPalette), Areas, BOM and Summary (invoice and DOCX). A "Project Total: $…" footer shows on the Products, Areas and BOM tabs. A 404 shows the destructive Alert "Project not found". Other errors show an Alert at the bottom. |
| `/catalog/products` | `FE/pages/catalog/ItemManagement.tsx` | auth | "Product Management". Search (300 ms debounce), filters for category (All, Uncategorized, …) and type, and a "Show inactive" switch. Table: chevron, image, name, model, type badge, category, status, and Edit/Delete (admin only). Expanding a row shows a Styles subtable built from a raw `<table>` (image, style, `$price`, status, Edit/Delete). Pagination is Previous / "Page X of Y" / Next with 10 per page. Admins also get "Import Catalog" (ImportModal) and "Add Product". |
| `/catalog/categories` | `FE/pages/catalog/CategoryManagement.tsx` | auth | "Category Management". "Show inactive" switch. Table: Position (sort_order plus up/down arrows for admin), Name, Status, and Edit/Delete for admin. "Add Category" is admin only. |
| `/catalog/item-types` | `FE/pages/catalog/ItemTypeManagement.tsx` | auth | "Product Type Management". Table: Order (arrows for admin), Type (colour dot and name), Abbreviation (`ItemTypeBadge`), and Edit/Delete for admin. "Add Type" is admin only. |
| `/settings/users` | `FE/pages/settings/UserManagement.tsx` | `requireTenantAdmin` (admin or tenant_admin) | "User Management". "Add User". Table: Name, Email, Tenant (admin only), Role badge, Status badge, Edit, and Delete (hidden on your own row). |
| `/settings/tenants` | `FE/pages/settings/TenantManagement.tsx` | `requireAdmin` | Tenants table: Name, Type badge (Distributor/Partner), Status badge, Edit, and Delete (disabled for the distributor). The "Delete" button calls `tenantService.deactivate`. |
| `*` | `FE/pages/NotFound.tsx` | public; no Layout | "404 / Page not found / The page you're looking for doesn't exist or has been moved." plus a "Go back home" button. |

Header nav (`FE/components/layout/Header.tsx`):
- Logo with light and dark variants, linking to `/`.
- Home and Projects links.
- A **Catalog ▾** menu (Products, Product Types, Categories) for any authenticated user.
- A **Settings ▾** menu for tenant_admin and admin. It holds User Management; admins also get Tenants.
- A ThemeToggle.
- An avatar dropdown with the name, role label and tenant name (non-admin only), plus Profile and Sign out. Sign out calls `logout()` and then `navigate('/login')`.
- The nav is `hidden md:flex` and nothing replaces it on mobile.
- The unauthenticated "Login" button branch can never render, because the header only appears inside protected routes.

## Cross-cutting behaviour (acceptance criteria)

### Auth & session
- AC-A1: On app load with no tokens, the app is unauthenticated straight away (`AuthContext.tsx:29-37`).
- AC-A2: On app load with only a refresh token, it refreshes first and then calls `GET /auth/me` (`AuthContext.tsx:41-45`).
- AC-A3: If `/auth/me` returns 401 on load, tokens are cleared. Any other failure, such as a network error, keeps the tokens but leaves the user null (`AuthContext.tsx:50-62`).
- AC-A4: While auth is resolving, protected routes show a full-screen spinner (`ProtectedRoute.tsx:18-24`).
- AC-A5: An unauthenticated user on any protected route is redirected to `/login` with replace. Failing the role check redirects to `/` with replace (`ProtectedRoute.tsx:26-36`).
- AC-A6: Every request gets `Authorization: Bearer <access>` when a token exists. FormData requests get no forced Content-Type; all others get `application/json` (`api.ts:33-55`).
- AC-A7: On a 401 (except from `/auth/login` and `/auth/refresh`):
  - Without a refresh token, the app clears tokens and fires `auth:logout`.
  - With one, it refreshes once and replays the original request. Concurrent 401s queue and resolve with the new token, or reject together if the refresh fails (`api.ts:65-139`).
- AC-A8: Tokens are cleared and `auth:logout` fires only when the refresh itself returns 401. Network errors never log the user out (`api.ts:76-80, 124-133`).
- AC-A9: A refresh rotates both tokens (`auth.ts:80-94`).
- AC-A10: Logout calls `POST /auth/logout`, ignores errors and always clears tokens. `logoutAll` (`/auth/logout-all`) exists in the context but **has no UI**.
- AC-A11: `?return_to` is honoured only for same-origin relative paths, to block open redirects (`Login.tsx:28-34`).
- AC-A12: The backend login also sets an `oauth_session` cookie, which the MCP OAuth consent flow uses (`backend/tests/routes/auth_session_cookie_test.ts`).

### Roles in the UI
- AC-R1: Catalog write actions (add, edit, delete, reorder, import) appear only for `role==='admin'`. Tenant admins and users get a read-only catalog.
- AC-R2: User Management is open to admin and tenant_admin. Only admins see the Tenant column and tenant selection.
- AC-R3: Only admins can reach Tenant Management.
- AC-R4: Role `user` gets a read-only configurator: drag sensors are disabled, every mutate callback is a no-op and a banner shows. Users cannot edit or delete groups in ProjectList. Version actions in ProjectList are **not** gated.
- AC-R5: Only admins see the Tenant column in ProjectList, and the project form shows a tenant picker for admins.

### Theme / dark mode
- AC-T1: The theme is persisted in `localStorage.theme`, defaults to `light` and toggles the `dark` class on `<html>` (`ThemeContext.tsx`). The toggle shows a Moon icon in light mode and a Sun icon in dark mode, with the sr-only label "Toggle theme".
- AC-T2: The `system` theme value exists in the type but is treated as light. Nothing reads `prefers-color-scheme`.
- AC-T3: Brand primary is purple `#8C00AA` (`hsl(290 100% 33%)`, or 45% in dark mode). Tokens live in `FE/styles/globals.css`. Logos have separate light and dark PNGs, switched with `dark:hidden` / `dark:block`.

### Sync context
- AC-S1: On mount, but only if an access token exists, the app fetches `GET /settings/last-sync-timestamp` and stores it globally. `itemService.getImageUrl` appends `?t=<ts>` to `/uploads/...` image URLs as a cache-buster after an Excel sync (`SyncContext.tsx`, `services/item.ts:87-215`).
- No component consumes `useSync`, and `refreshTimestamp` is never called after an import or a login (see Suspected bugs).

### Loading / empty / error states
- Every list page shows a full-page `Loader2` spinner (`h-64`) while loading. **Refetching after a mutation sets `isLoading` again, so the whole table flashes to the spinner.** ItemManagement is the exception: its spinner sits inside the table body.
- Empty tables show one centred muted row, "No X found. Create your first X to get started.", even for roles that cannot create.
- Errors appear in an inline destructive `<Alert>` above the content. Messages come from `extractErrorMessage` (`FE/utils/errors.ts`): Zod `issues[].message` joined with ", ", or a string `error`, or a fallback.
- Modals show errors inside the modal. `ConfirmDeleteModal` stays open when `onConfirm` throws and shows the `error` prop if one is passed.
- Only `/projects/:id` has an `ErrorBoundary`. It shows "Something went wrong", the error message and a "Try again" reset button.
- Submit buttons change to "Saving..." or "Signing in..." with a spinner and are disabled while submitting.

### Notifications
- There are no toasts. Success feedback is only an inline Alert (Profile) or the modal closing.
- `BomPanel.tsx:41` uses the native `confirm()` for "Update BOM prices from current catalog?".
- The versioning spec asks for a toast "Version 'X' created", which was not built.

### Locale / currency / units (hard-coded)
- All UI text is English and `<html lang="en">`. There is no i18n framework.
- Money is always prefixed with `$` and formatted with `toLocaleString('en-US', 2dp)`. This is duplicated in `utils/formatting.ts`, `BomPanel`, `ConfiguratorCanvas`, `InvoiceSummary`, `SummaryTab`, `InvoiceSettingsModal` and `invoice-docx.ts`. ItemManagement uses `price.toFixed(2)`.
- The invoice model is USD-based (`discount_usd`, `services_usd`, "Grand Total USD") with a local currency and exchange rate. The local currency defaults to **`PKR`** (`InvoiceSettingsModal.tsx:51,79,88`, `SummaryTab.tsx:77`, `invoice-docx.ts:451`).
- Dates: version dates use `toLocaleDateString('de-DE')` (`ProjectList.tsx:450`). Project numbers use the UTC ISO date.
- The DOCX uses the font "Bahnschrift Light" (not embedded) and a column header "Unit Price ($)".
- No physical units appear. Canvas coordinates are natural image pixels with (0,0) at the top-left.

### Persistence in the browser
- `localStorage`: `accessToken`, `refreshToken`, `theme`, and per-project item size and variant memory (`hooks/useItemMemory.ts`; keys are asserted in `tests/ProjectDashboard.memory.test.tsx`).

### Responsive / mobile
- The header nav is hidden below `md` and there is no hamburger menu, so on phones you can only get around via Home and the avatar menu.
- The configurator does not adapt (fixed 400 px panel, canvas fills the rest, no touch-specific handling beyond the dnd-kit PointerSensor with an 8 px activation distance).
- Tables have no horizontal-scroll or card fallback. The only responsive classes are dialog widths (`sm:max-w-*`) and the Home grid (`md:grid-cols-3`).
- `#root` styles in `App.css` and `index.css` are leftover Vite scaffold. Neither file is imported (`main.tsx` imports only `styles/globals.css`).

### Dev/ops
- The API base is `VITE_API_URL`, defaulting to `/api`. Vite proxies `/api` and `/uploads` to `localhost:8000`. In dev, every request and response is logged to the console.

## UI inconsistency audit

Components in `FE/components/ui`: alert, avatar, badge (default/secondary/destructive/outline), button (default/destructive/outline/secondary/ghost/link; sizes default/sm/lg/icon), card, checkbox, dialog (base `max-h-[90vh] flex flex-col`), dropdown-menu, input, label, select, separator, switch, table, tabs, textarea. Shared app components: `common/ConfirmDeleteModal`, `common/ErrorBoundary`, `common/ThemeToggle`, `items/ItemTypeBadge`.

**Buttons that bypass `<Button>`:**
- `layout/Header.tsx:73,109,146`: dropdown triggers are raw `<button>`.
- `common/ErrorBoundary.tsx:38`: "Try again" is a raw styled button.
- `floorplans/FloorplanTabs.tsx:40-80`: icon buttons for rename, move and delete; the "+" add tab is a clickable `<div>`.
- `configurator/ConfiguratorCanvas.tsx:521,532,1588,1596`: round floating edit and delete buttons on placements and areas.
- `configurator/ItemPalette.tsx:223,252,259`: type-filter chips.
- `pages/catalog/ItemManagement.tsx:498`: expand chevron. ProjectList uses `<Button variant="ghost">` for the same job.
- `items/VariantFormModal.tsx:309,354,380`: image remove buttons and others.
- `items/ImportModal.tsx:254`.
- `items/ItemTypeFormModal.tsx:117` and `configurator/AreaEditModal.tsx:96`: identical **duplicated colour-swatch picker** with a raw `<input type="color">`.

**Tables:** `ItemManagement.tsx:602-660` builds the Styles subtable from raw `<table>/<thead>/<tr>` rather than `ui/table`.

**Form controls:**
- Raw `<input type="checkbox">` in `projects/ProjectFormModal.tsx:170` (item-type selection) and `invoice/ExportTypeDialog.tsx:35`, even though `ui/checkbox` exists. Only `ConfiguratorCanvas` uses `ui/checkbox`.
- Raw `<label>` instead of `<Label>` for "Show inactive" in `CategoryManagement.tsx` and `ItemManagement.tsx`.
- Hidden raw file inputs in `FloorplanFormModal.tsx:220`, `VariantFormModal.tsx:294` and `ImportModal.tsx:239`. This is acceptable, but there is no shared upload/dropzone component.

**Status indicators (three different patterns):**
1. `<Badge>` in Users, Tenants and the role column.
2. Icon plus coloured text spans (`text-green-600` / `text-blue-600` / `text-red-600` / muted) in ProjectList, CategoryManagement and ItemManagement (items and styles).
3. Ad-hoc pills: `VariantFormModal.tsx:476` (`bg-red-100` / `bg-green-100`, required/optional addon), `ItemPalette.tsx:223` and `ConfiguratorCanvas.tsx` type chips.

Hard-coded colours have no dark variants in `Profile.tsx:83` (success Alert), `ConfirmDeleteModal.tsx:66` (error box), `BomPanel.tsx:116` (`bg-yellow-50` change report) and the ProjectList, Category and Item status colours. `ImportModal` does add dark variants.

**Modals:**
- **Inline modals**, against the rule in CLAUDE.md and AGENTS.md: the Edit Version dialog in `ProjectList.tsx:540-590`, and `PlacementEditModal` defined inside `ConfiguratorCanvas.tsx:598+` (same file, not separately exported).
- **Two delete-confirm implementations:** `ConfirmDeleteModal` and `floorplans/DeleteFloorplanDialog.tsx`. The second puts its buttons in a plain `div`, not `DialogFooter`, and repeats its text twice. `BomPanel` uses native `confirm()`. Placement, area and area-vertex deletes on the canvas and in AreasPanel happen **without confirmation**.
- **Prop naming:** `isOpen` in most modals, but `open` in `ItemTypeFormModal` and `ExportTypeDialog`. `AreaEditModal` opens when `area` is non-null.
- **Scroll pattern** (`flex-1 overflow-y-auto` body with a sticky footer) is missing in ConfirmDeleteModal, DeleteFloorplanDialog, ExportTypeDialog, CreateVersionModal and the inline Edit Version dialog.
- Widths are arbitrary: 400, 425, 500, 550, 800/900 px, `max-w-md`, and the default.

**Table action buttons:** AGENTS.md and CLAUDE.md prescribe Flowbite `color="light"` / `color="failure"` `size="xs"`, which is stale. The code uses shadcn `variant="outline"` / `"destructive"` `size="sm"` with `h-3 w-3` icons. Edit always comes before Delete. ProjectList version rows add `className="h-8"`, and ItemTypeManagement uses inline `" Edit"` text spacing.

**Tabs:** the dashboard right panel overrides `TabsTrigger` with a long class string repeated four times (`ProjectDashboard.tsx:718-729`). `FloorplanTabs` re-implements the same underline-tab look by hand.

**Page headers:** every page repeats `h1.text-3xl.font-bold` plus a muted subtitle plus a right-aligned action. There is no shared `PageHeader` component. Some pages render an empty `<CardHeader />` (Users, Tenants) only to get spacing.

**Loading:** spinner markup (`Loader2 h-8 w-8 animate-spin text-primary` in an `h-64` flex box) is copy-pasted in about 8 places. There are no skeletons.

**Duplicated helpers:** `generateProjectNumber` exists three times (`ProjectList.tsx:44`, `ProjectDashboard.tsx:38`, `ProjectHeader.tsx:10`). Local `formatCurrency` exists in at least four components.

## Behaviours asserted by existing tests

### E2E (cucumber, `e2e/`)
- `@infrastructure` "Browser reaches both SnapFlow runtime layers":
  - The harness spawns a real backend on `127.0.0.1:18000` (temporary SQLite and uploads, `NODE_ENV=test`) and Vite on `127.0.0.1:4173`.
  - It clears localStorage per scenario and opens `/login`.
  - It asserts that the "Sign in" button and the "Email" label are visible, and that `GET /health` returns `{status:'ok'}`. Screenshots and traces are kept on failure (`e2e/support/hooks.ts`).
- `e2e/tests/url-trust.test.ts`: the runtime URLs are fixed to loopback, and the `E2E_BASE_URL` / `E2E_API_URL` overrides are rejected.
- `npm run e2e` also runs a scenario-traceability check (`tools/neo_dev_webhook/scenario_traceability`) before cucumber.

### Frontend: shell & auth
- AuthContext: no token means no user. `login` sets the user and `logout` clears it. The user loads from a stored token on mount. A 401 on `/me` clears the tokens.
- ProtectedRoute: redirects to `/login` when unauthenticated. Shows a spinner while validating. Redirects a non-tenant-admin to `/` when tenant admin is required. Renders content for an authenticated user, and for a tenant_admin when tenant admin is required.
- Header:
  - Renders the brand and the nav links (Home, Projects).
  - Shows a Login button when unauthenticated, and a user dropdown with the full name, falling back to the email prefix, plus the role label.
  - Shows admin menu items for admins only.
  - Sign out calls logout, and the Profile link appears in the dropdown.
- Login:
  - Renders the form and wires both inputs. Submitting calls `login(email,password)` and navigates to `/` on success.
  - Shows the server error message, or a generic one when there is no response.
  - Shows the loading state, and clears the previous error on resubmit.
  - Email and password are required.
  - Honours `return_to` and falls back to `/`.
- Profile: renders and shows the user info and avatar letter. Pre-fills the form. Sends only the changed fields. Shows the success message. Validates password length (≥ 6) and that the confirmation matches. Shows "No changes to save".
- Home: welcome text, Get Started and View Projects buttons, and three feature cards with descriptions.
- NotFound: the 404 title, "Page not found", the description and a Go back home button.
- ThemeContext: provides the context, starts as light, and `setTheme` works.
- ErrorBoundary: renders children normally, shows the fallback UI when a child throws, uses a custom fallback when one is given, and "Try again" resets it.
- ConfirmDeleteModal: renders the title and warning. Delete calls `onConfirm` and Cancel calls `onClose`. It closes after a successful confirm, and `disabled` disables Delete.

### Frontend: catalog
- CategoryManagement: title, initial loading, fetches and lists categories, the add button opens the modal, and the error state on a fetch failure.
- CategoryFormModal: create mode when the category is null and edit mode pre-filled. Cancel closes. The button reads Update in edit mode and Create in create mode. The active toggle appears only in edit mode.
- ItemManagement: renders, fetches and lists items, "Add Product" opens the modal, the empty state, and the fetch-error state.
- ItemFormModal: create mode and edit mode pre-filled. The category dropdown is present. Cancel closes.
- VariantFormModal: create and edit modes, required-field validation, Cancel closes.
- ImportModal: renders in both the closed and open states (smoke test only).
- ItemTypeManagement: loading, then a list. "Add Type" is visible to admins and hidden from others.
- ItemTypeBadge: shows the abbreviation and applies the background colour and className.
- itemTypeService:
  - `GET /item-types` (with `include_inactive` when asked)
  - `POST /item-types`
  - `PUT /item-types/:id`
  - `DELETE /item-types/:id`
  - `PATCH /item-types/reorder` with the ids

### Frontend: projects & configurator
- ProjectList: render smoke test only.
- ProjectFormModal: create mode with null, edit mode pre-filled, Cancel closes. "Customer name" is required in create mode and "version name" in edit mode. Update and Create labels.
- UserManagement: renders with loading. Lists users with role badges. Edit and Delete appear per row, and Delete is hidden for the current user. "Add User" opens the modal and create succeeds.
- UserFormModal: create and edit modes, Cancel, Update and Create labels, and a password hint in edit mode ("leave blank to keep").
- FloorplanFormModal:
  - Create and edit modes; shows the paste instruction; the name is required; Cancel closes.
  - Clipboard image paste is accepted. Non-image pastes, and pastes while typing in an input, are ignored. There is no paste listener while the modal is closed. An oversized pasted image shows an error.
  - Submitting sends the pasted image.
- AreasPanel: renders the draggable area block, shows "No areas placed yet" when empty, and lists areas with names and device counts. Delete calls `onDeleteArea` and clicking calls `onSelectArea`.
- ItemPalette: loading, then categories and items. Fetches items with `limit=1000`. Shows the item image and details, or a "No Image" placeholder. Category visibility toggles and count badges work. Hidden categories are styled as hidden. Toggling calls `onToggleCategory`. Everything is visible by default.
- Drag calculation (`calculateDragPosition`): `final = initial + delta/scale`. Covered for scale, zero and negative deltas, separate X and Y scales, zoom levels, fractions, rotations of 0/90/180/270 (the delta is unaffected), tiny scales, large coordinates and precision.
- DraggablePlacement and Canvas data tests: placement position, size, image, delete, resize, select, and drop position in natural coordinates. These are mostly data-shape tests.
- BomPanel and RightPanel data tests: entry shape, child→parent link, group, floorplan and project totals, thousands-separator formatting, and empty BOM. Style name is included.
- useBomCalculations:
  - Empty totals and a zero total with no BOM.
  - Aggregates name, quantity and total; the project total is the sum of the floorplans.
  - Addon children are handled.
  - Items are enriched with `categoryName` and `categorySortOrder`, with "Other" for an unknown category.
  - Duplicate items are merged across groups.
- Item memory (`useItemMemory`): localStorage keys, Map↔array serialisation, save and load of size and variant memory, graceful handling of missing or corrupt data, and clearing one item persists.
- point-in-polygon: inside and outside a rectangle and an L-shape. The shoelace area is correct. `findContainingArea` returns the area, null when outside, and the smallest area when areas overlap.
- floorplan-export (PNG):
  - The canvas has the image's dimensions, draws the floorplan, and draws placements with position and rotation and rounded borders.
  - Uses the item preview image when the variant has none, and draws a placeholder when there is no image at all. Handles multiple placements and keeps drawing if one fails.
  - Downloads as PNG with a sanitised filename. Supports a background colour and a quality setting.
  - Placements are filtered by visible categories; placements with unknown items are kept.
- InvoiceSettingsModal: renders with initial or empty values. A discount % computes its reference value. The preview totals are right. Save calls onSave and onClose; Cancel calls onClose. Refresh fetches the exchange rate. Save errors are shown. Nothing renders when closed. Empty strings are handled.
- SummaryTab:
  - Shows content when totals exist. With no floorplans it shows the empty state at once; with floorplans but no totals it shows loading.
  - Shows the floorplan breakdown, and the invoice summary when settings exist. Otherwise it shows a configure button that calls `onConfigureInvoice`.
  - Shows the DOCX buttons ("Create Invoice (DOCX)") when configured.
  - Formats currency and recalculates when totals change.

### Backend (Deno, in-memory SQLite) — grouped
- **Server**:
  - `/health` returns `ok` and `/` returns API info.
  - Unknown `/api/*` returns a JSON 404.
  - Path traversal through `/uploads` returns 404, and a missing upload returns 404 rather than 500.
- **DB schema**: the migrations table exists. The structures of users, categories, items, projects (with indexes on `project_group_id` and `tenant_id`), floorplans and placements are checked, and FK constraints exist.
- **Auth**:
  - Login: valid credentials succeed; an invalid email or password gives 401; missing fields give 400.
  - `/auth/me`: works with a valid token; no token or an invalid token gives 401.
  - Logout works.
  - Refresh: valid succeeds and rotates; the old refresh token is rejected; an invalid one is rejected; the refreshed token reaches protected routes.
  - `PUT /auth/me` updates full_name, email or password. A short password is rejected, and a request with no changes fails.
  - Login and refresh are blocked with 403 for an inactive user or a user in an inactive tenant.
  - The login and `/me` responses include `tenantId` and `tenantName`.
  - Login sets the `oauth_session` cookie.
- **Services**: password hash and compare. JWT generate, verify, and rejection of invalid or tampered tokens. Refresh tokens: create (unique), verify, revoke, revoke-all, and cleanup of expired tokens that keeps valid ones.
- **Rate limit**: requests within the limit pass; over the limit gives 429 with Retry-After; X-RateLimit headers are set; the window resets; the store can be cleared; keys are counted independently. Private IPs in X-Forwarded-For fall through. XFF is ignored unless `TRUSTED_PROXY` is set.
- **Upload validation**: magic bytes accept JPEG, PNG, WebP and XLSX, and reject random or empty buffers. `processImageSafe` returns the original buffer for non-images and small buffers.
- **Users**:
  - Admins can create, list, update (name, email, password, role) and delete users. Non-admins cannot create or list.
  - Duplicate emails are rejected; you cannot delete yourself; an update with no changes fails; a missing user gives 404; a created user can log in.
  - Admins cannot be deactivated (403), but tenant_admins can. Only admins can change `tenant_id`; a tenant admin's attempt is ignored.
  - UserRepository: CRUD, find by email or id, and nullable full_name.
- **Tenants**:
  - Admins can create partner or distributor tenants, list, get, update the name, and toggle `is_active` and `is_distributor`.
  - Duplicate names give 409 and an empty name gives 400.
  - Delete is a hard delete only when the tenant has no projects, and it also deletes the tenant's users. A tenant with projects is rejected, and deleting a distributor gives 403.
  - tenant_admin and user get 403 on every route.
- **Categories**:
  - Public list and get, with 404 for a missing id.
  - Create, update, delete and reorder are admin-only (non-admin is rejected) and need auth. Duplicate names are rejected.
  - Deactivating a category cascades to its items and variants; activating does not cascade. Reorder is atomic.
- **Item types**: list active types. Admins can create (duplicate names rejected) and update. Delete is blocked when items exist. There is a separate deactivate, and reorder works. `GET /items?type_id` filters, and `POST /items` and `sync-catalog` need a `type_id` (400). A non-canonical `type_id` is rejected without touching the catalog.
- **Items/variants/addons**:
  - Public list with category filter and search. `include_inactive` works for admins only; unauthenticated requests get only active records.
  - Getting an item includes its variants, with 404 when missing.
  - Create, update and delete are admin-only and need auth. An invalid category and missing fields are rejected. Delete cascades to variants and addons in one transaction with rollback.
  - Variant list, create, update (including an image-remove flag) and delete. Addon list, add (duplicates rejected) and remove.
- **Excel import/sync**:
  - Creates missing categories (with a warning), items, all variants and addons, and updates existing items. The result has the expected shape.
  - It only deactivates missing items **of the selected product type**, and an empty import set is rejected.
  - An invalid type, an empty, unreadable or malformed workbook, or a persistence failure rolls back with the catalog unchanged.
  - Embedded images stay inside the isolated upload root, and cleanup keeps normal uploads.
  - A missing file is handled gracefully. Results are the same whether tests run isolated or in order.
- **Projects/groups/versions**:
  - Create needs `customer_name`; status is optional. List, search, get (404) and update (404) work. Auth is required. All customer fields are supported.
  - New projects take the caller's tenant. Tenant users see only their own tenant; admins see all. Only admins can change `tenant_id`.
  - Users cannot delete (403). Editing by users is allowed: the test named "user cannot edit (403)" actually asserts 200.
  - The only version cannot be deleted (400). Deleting a non-last version works and unlinks its BOM picture files.
  - A group can be deleted only when it is empty; a group with data is rejected, a missing group gives 404, and a user gets 403.
  - Without an explicit list, all active item types are auto-assigned; `PUT` updates `item_type_ids`.
- **Floorplans**: CRUD with an image (name and image are required), 404s, reorder, and auth required. Deleting removes the image file.
- **Placements**:
  - CRUD with validation and 404s.
  - Duplicate gives 404 when missing and 400 when coordinates are missing, and returns the image path.
  - `area_id` is assigned by containment, both on create and on duplicate.
  - Responses include `item_variant_image_path`. `POST /placements/bulk-update` is reachable, which checks route order.
  - The BOM entry snapshots `item_type_name`.
- **Areas**: create with default vertices, list by floorplan, update, update vertices (recomputing the bbox), and delete (setting contained placements' `area_id` to null). Placements can be assigned to areas.
- **BOM**:
  - Creating a placement auto-creates a BOM entry with its required addons (optional addons are not added). Deleting the last placement removes the entry.
  - The floorplan BOM is hierarchical, and the project total is the sum of the floorplans.
  - recreate and switchVariant copy images into the project folder (the path contains the entry id). Delete cleans up unused images.
  - updateFromCatalog refreshes the snapshot, including the picture, and `totalAfter` reflects the new prices.
  - `findByPicturePath` works. The image migration is idempotent.
  - `GET /bom-entries/:id` checks the tenant: another tenant gets 404, a bad id 400, no auth 401.
- **Invoice**:
  - Settings: `PUT /project-groups/:id/invoice-settings` (partial updates allowed, 404 for a missing group).
  - `GET /projects/:id/invoice-calculation`.
  - Calculation covers discount only, services only, both, negative totals, the reference % values, zero exchange rate, and USD/PKR formatting.
  - `GET /currency/exchange-rate/:code`, with a cache and handling of invalid codes.
- **Settings**: `GET /settings/last-sync-timestamp` gives 401 without auth, 0 if never synced, and the stored value otherwise (admin too).
- **File storage**: copyFile copies, generates a unique name, handles project folders, and returns the original path on failure.
- **Data integrity**: `withTransaction` and `withTransactionAsync` commit or roll back. Deleting a floorplan cleans up its placements, and deleting a BOM entry cleans up its child placements.
- **MCP / OAuth** (read-only connector):
  - `/mcp` gives 401 with `WWW-Authenticate` when there is no or a bad bearer token. `tools/list` returns 10 tools.
  - Tools: list_projects (search), get_project, get_version_total, search_items (limit), list_floorplans, get_floorplan_bom (enriched with names, placement coordinates, canvas dimensions and areas), list_areas, get_invoice_calculation and get_item_picture (accepts exactly one of bom/variant/item ids, falling back to the first active variant image). The image tools' descriptions warn that the user cannot see the image.
  - Tenant isolation holds through MCP.
  - OAuth:
    - Register needs `redirect_uris`.
    - Authorize redirects to login when there is no session, and to consent when there is one. It rejects an unknown client or an unregistered redirect.
    - Consent Allow issues a code; Deny returns an error to the client.
    - Token: PKCE S256, code reuse rejected, refresh rotation, and the client_secret is enforced.
    - `.well-known` metadata honours X-Forwarded-*.
- **Test harness**: tracked env, an injected in-memory DB, unique upload roots, deterministic reset and teardown, and a hostile cwd `.env` is ignored.

## Documented requirements & unbuilt features

From `IMPLEMENTATION_PLAN.md` (last updated 2026-02-22, stale):
- Phase 8 "Proposals" is unchecked. It asks for a server-side `POST /projects/:id/proposal` that generates Excel/PDF from the BOM, with dynamic floor columns, empty-state validation, a download with proper naming, loading/error/success feedback, and golden-file tests. What exists instead is client-side DOCX (`services/invoice-docx.ts`) and PNG export. There is no Excel or PDF proposal.
- 6.2: keyboard support (Delete for the selected item, Esc to deselect) is marked "future". The canvas does handle Escape and Ctrl/Meta for duplicate-drag (`ConfiguratorCanvas.tsx:1129-1148`), but Delete-key removal is unconfirmed.
- 9.2: an E2E smoke flow is listed but not built: import catalog → create project → upload floorplans → place items → change variant and addons → delete BOM entry → update from catalog → export proposal. This is the recommended first set of acceptance scenarios.
- 9.3: consistent loading, empty and error states, plus clear messages for invalid or inactive references.
- Week 3: "Custom picture upload" for BOM entries is not built.
- 7.9 says variant memory is "session-based (clears on refresh)", but the code now persists it in localStorage per project.

From `README.md` (stale):
- Claims Excel proposals, "Customer Management" (now embedded in project groups), admin/user roles only, and "Smart Sizing – resize syncs all instances of the same item type".
- The routes table lists `/catalog/items` (actually `/catalog/products`) and a Customers nav entry that does not exist.
- Lists only 4 MCP tools; the tests expect 10.
- Says logout invalidates all refresh tokens.
- Gives JWT lifetimes of 15 min access and 7 day refresh. Login is rate-limited to 10 per 5 min per IP and refresh to 10 per minute.

From `AGENTS.md` / `CLAUDE.md`:
- UI rules: modals live in separate components, with `entity|null` meaning create or edit.
- Button labels are Create, Update, Cancel and Delete, with Plus, Save, X and Trash2 icons (`mr-2 h-4 w-4`), and the submit shows "Saving...".
- Titles are "Create {Entity}" and "Edit {Entity}".
- Terminology: Products = items, Styles = variants.
- Table action buttons put Edit before Delete. The documented Flowbite props are stale.

From `docs/superpowers/specs/`:
- Multi-tenancy (`2026-03-26`), still unbuilt in the UI:
  - A **tenant switcher in the header** for the distributor ("All Tenants" plus the partners), passing `?tenantId=`.
  - A **tenant filter** on the Users and Projects pages.
  - A guarantee that at least one distributor always exists (the last distributor cannot be deleted or demoted).
  - The spec says `user` can "create and edit projects". The UI makes `user` read-only in the configurator.
  - Out of scope: per-tenant branding, per-tenant catalogs, billing.
- Project versioning (`2026-05-11`), parts unbuilt or different:
  - The list should sort by group creation date **descending** (code sorts ascending by project-number string).
  - The group row should show a version-count column (missing).
  - A toast "Version 'X' created" is missing.
  - ProjectHeader should show a breadcrumb `[Group] > [Version]` (it shows number, version and customer).
  - The version name must be unique within its group (validated in CreateVersionModal).
- Frontend resilience (`2026-03-23`): the auth-event logout, the refresh queue rejecting, the drag-duplicate await, ref-based placements, delete error handling and the ErrorBoundary are all implemented. "ProtectedRoute dual source of truth" and console logging were deferred.
- Modal overflow (`2026-03-23`, issue #51): dialogs are capped at the viewport height with a scrollable body and a sticky footer.
- Invoice sorting (`2026-03-23`, issue #50):
  - DOCX items are sorted by category `sort_order`, then by name, with each addon directly under its parent. Addons are keyed by parent and addon name.
  - The font is Bahnschrift Light 9 pt.
  - Unknown items go to "Other" at the end.
- Show-inactive (`2026-07-12`): `include_inactive` works for admins only. Inactive products keep a preview from their first style.
- Product-type import scope (`2026-07-12`): an import deactivates only missing items of the chosen type.
- Areas (`2026-03-24`): future BusPro columns on `area_properties` (relay_zones, dimming_zones, dali_ballasts, dmx_zones).
- MCP (`2026-05-15` and `2026-05-16`): read-only v0. Planned later: write tools with scopes (`projects:read`/`write`), uploads and placement operations. The spec mentions a `frontend-v2/`, which no longer exists.
- Security (`2026-03-23`): deferred items are IDOR/ownership checks (intentionally a shared workspace within a tenant), `*` CORS on uploads, and no-origin CORS.

Other: `backend/src/services/excel-import.ts:386` has "TODO: Implement image matching logic".

## Suspected bugs

1. **The OAuth `return_to` is dropped.**
   - The backend redirects to `/login?return_to=<absolute c.req.url>` (`backend/src/routes/oauth.ts:69`, `oauth-consent.ts:25`).
   - `Login.tsx:30` only accepts values that start with `/`, so after logging in the user lands on `/` instead of finishing the MCP OAuth authorize flow.
   - Even with a relative path, `navigate()` stays inside the SPA, so `/oauth/authorize` would render NotFound. A full page navigation is needed.
2. **The project dashboard spins forever on a non-404 load error.** `ProjectDashboard.tsx:615-629`: when `project` is null and `showNotFound` is false, it shows a spinner and never the error.
3. **The read-only banner text is wrong.** It says "…read-only because it is no longer active", but the condition is `role==='user'`, not project status (`ProjectDashboard.tsx:76,638-642`). Completed or cancelled projects are still fully editable.
4. **Role gating is inconsistent in ProjectList.** Version Copy, Edit and Delete show for `user` (`ProjectList.tsx:455-490`), but the backend returns 403 on delete. The backend also lets `user` edit projects, while the frontend makes them read-only. The backend test "user cannot edit projects (403)" asserts 200 (`backend/tests/routes/projects_tenant_test.ts:405-434`).
5. **Silent delete failures.** CategoryManagement, ItemTypeManagement and UserManagement pass no `error` to `ConfirmDeleteModal`, and their handlers do not catch. When a delete fails (for example a category or type that still has items), the modal just stays open with no message. TenantManagement catches the error but closes the modal and shows a page-level error.
6. **`ConfirmDeleteModal` `disabled` is overloaded.** ProjectList passes `disabled={isDeleting}`, so while deleting, the dialog switches to the amber "info" state and shows an empty `disabledMessage` (`ConfirmDeleteModal.tsx:46-53`, `ProjectList.tsx:620-640`).
7. **Tenant "Delete" actually deactivates.** It calls `tenantService.deactivate`, but the copy says it is permanent and cannot be undone. The backend does have a hard delete (`TenantManagement.tsx:52-60`).
8. **Abort detection never matches.**
   - Pages compare `extractErrorMessage(err,'') !== 'AbortError'`, but that function never returns an error name. `useProjectData` checks `err.name === 'AbortError'`, while Axios uses `CanceledError`.
   - So aborted requests, such as a superseded search or an unmount, can set error banners like "Failed to fetch projects".
9. **SyncContext is effectively dead.**
   - The timestamp is fetched only at mount and only if an access token exists, so not after a fresh login or a token refresh.
   - It is never refreshed after an Excel import, so image cache-busting fails until a reload.
   - `useSync` has no consumers.
   - `/settings/last-sync-timestamp` returns `{success, data}`, which departs from the API format.
10. **A refresh failing with 403 does not log the user out.** This happens when the user or tenant is deactivated mid-session (`api.ts:124-133` only handles 401). The user stays inside the app while every request fails.
11. **The `system` theme is accepted but not implemented.** It renders as light.
12. **Mutations cause a full-page spinner flash.** Every list page refetches with `setIsLoading(true)`, which unmounts the table and resets scroll and expanded state.
13. **The configurator loads at most 1000 catalog items** (`useProjectData.ts:64`; ItemPalette also uses `limit=1000`). Anything beyond that is silently truncated.
14. **The "Show inactive" switch is shown to non-admins** on Products and Categories, but the backend ignores the flag for them.
15. **The empty-state copy asks read-only roles to "Create your first …".**
16. **The e2e harness API base is wrong.** It sets `VITE_API_URL=http://127.0.0.1:18000` without `/api`, but the backend mounts its API at `/api` (`backend/src/main.ts:128`). Also, `/uploads` would be proxied to `localhost:8000`, not `18000`. Any future scenario that logs in will 404. The current tracer only checks that the login page renders and `/health` responds.
17. **Logging in while already authenticated** shows the form again with no redirect. `logoutAll` exists but has no UI.
18. **Dates are inconsistent.** Project numbers use the UTC ISO date, which can show the previous or next day near midnight, while version dates use `de-DE`. The project-list sort is lexical on a `date_customer_address` string, which effectively puts the oldest first.
