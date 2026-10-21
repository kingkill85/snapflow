import { type APIRequestContext, type Browser, type BrowserContext, expect, type Locator, type Page, request, test as base } from '@playwright/test'

import { admin, backendURL, frontendURL } from './env'

export { expect }

export type Role = 'admin' | 'tenant_admin' | 'user'
export type Tenant = { id: string; name: string; isDistributor: boolean; isActive: boolean }
export type User = { id: string; email: string; fullName: string; role: Role; tenantId: string; isActive: boolean }
export type Localized = { en: string; de?: string }
export type AttributeType = 'text' | 'number' | 'integer' | 'boolean' | 'enum' | 'list'
export type Attribute = {
  key: string
  label: Localized
  description?: Localized
  type: AttributeType
  required?: boolean
  unit?: string
  scope?: 'product' | 'variant'
  min?: number
  max?: number
  itemType?: 'text' | 'number' | 'integer' | 'boolean' | 'enum'
  options?: { key: string; label: Localized }[]
}
/** A product type: the system or product line (Zigbee, KNX, …), shown as a badge. */
export type ProductTypeInput = {
  key: string
  name: Localized
  abbreviation?: string
  color?: string
  isActive: boolean
  topology?: 'bus' | 'wireless' | 'none'
  addressing?: 'knx_individual' | 'hdl' | 'eui64' | 'none'
  defaultBusCurrentMa?: number
  busDevicesMax?: number
  defaultWirelessPlacesUsed?: number
  reservePercent?: number
  nominalVoltage?: number
}
export type ProductType = ProductTypeInput & { id: string; sortOrder: number; updatedAt: string }
/** A category: the kind of device, with the attribute schemas. */
export type CategoryInput = {
  key: string
  name: Localized
  description?: Localized
  isActive: boolean
  attributes: Attribute[]
  instanceAttributes: Omit<Attribute, 'scope'>[]
}
export type Category = CategoryInput & { id: string; sortOrder: number; updatedAt: string }
/** A product type and a category created together: every product needs one of each. */
export type Kind = { type: ProductType; category: Category; ids: { productTypeId: string; categoryId: string } }
export type ProductInput = {
  productTypeId: string
  categoryId: string
  modelNumber: string
  name: Localized
  description?: Localized
  attributes?: Record<string, unknown>
  isActive?: boolean
  /** Create only: the first variant (D449); left out, the API adds "Standard" at price 0. */
  firstVariant?: { name?: Localized; sku?: string; price: string; attributes?: Record<string, unknown> }
}
export type VariantInput = {
  name: Localized
  sku?: string
  price: string
  imageFileId?: string
  attributes?: Record<string, unknown>
  isActive?: boolean
}
export type Addon = { addonVariantId: string; productId: string; required: boolean; sortOrder: number }
export type Variant = Required<Pick<VariantInput, 'name' | 'price' | 'attributes' | 'isActive'>> &
  Pick<VariantInput, 'sku' | 'imageFileId'> & {
    id: string
    productId: string
    staleAttributes: Record<string, unknown>
    available: boolean
    addons: Addon[]
    updatedAt: string
  }
export type Product = Required<Pick<ProductInput, 'productTypeId' | 'categoryId' | 'modelNumber' | 'name' | 'attributes' | 'isActive'>> &
  Pick<ProductInput, 'description'> & {
    id: string
    staleAttributes: Record<string, unknown>
    available: boolean
    variants: Variant[]
    variantsWithProblems: number
    updatedAt: string
  }
export type Project = { id: string; number: string; name: string; status: string; updatedAt: string; exchangeRate: string | null; versions: { id: string; name: string }[] }
export type StoredFile = { id: string; contentType: string; size: number; width: number; height: number; sha256: string }
/** A user created by a spec, with the password it signs in with. */
export type Account = User & { password: string }
export type PlanContent = {
  scale: number | null
  zones: { id: string; name: string; color: string; opacity: number; points: number[][] }[]
  placements: { id: string; x: number; y: number; width: number; height: number; rotation: number; zoneId: string | null }[]
  needs: {
    id: string
    zoneId: string | null
    functionTypeId: string
    quantity: number
    powerW: string | null
    loadTypeId: string | null
    label: string
    note: string
    x: number | null
    y: number | null
  }[]
}

let counter = 0
/** A name no other spec (or earlier run) uses, e.g. "Tenant k3x9a1-2". */
export function unique(prefix: string): string {
  counter += 1
  return `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}-${counter}`
}

/** A unique key (lower snake case), e.g. "pt_k3x9a1_2". */
export function uniqueKey(prefix: string): string {
  return unique(prefix).replace(/[\s-]+/g, '_').toLowerCase()
}

/** A unique email address. */
export function uniqueEmail(prefix = 'user'): string {
  return `${unique(prefix).replace(/\s+/g, '-').toLowerCase()}@e2e.test`
}

/**
 * Seeds data straight through the backend API, for things a spec needs but
 * does not test. Everything a spec tests goes through the UI.
 */
export class Api {
  readonly ctx: APIRequestContext

  private constructor(ctx: APIRequestContext) {
    this.ctx = ctx
  }

  static async login(email: string, password: string): Promise<Api> {
    const ctx = await request.newContext({ baseURL: backendURL })
    const res = await ctx.post('/api/auth/login', { data: { email, password } })
    expect(res.status(), await res.text()).toBe(200)
    return new Api(ctx)
  }

  private async json<T>(res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
    expect(res.ok(), `${res.url()}: ${res.status()} ${await res.text()}`).toBe(true)
    return (await res.json()) as T
  }

  async tenants(): Promise<Tenant[]> {
    return (await this.json<{ items: Tenant[] }>(await this.ctx.get('/api/tenants'))).items
  }

  async distributor(): Promise<Tenant> {
    const tenant = (await this.tenants()).find((t) => t.isDistributor)
    if (!tenant) throw new Error('no distributor tenant')
    return tenant
  }

  async createTenant(name = unique('Partner'), isActive = true): Promise<Tenant> {
    return this.json<Tenant>(await this.ctx.post('/api/tenants', { data: { name, isActive } }))
  }

  async createUser(input: { role?: Role; tenantId?: string; fullName?: string; email?: string; password?: string; isActive?: boolean } = {}): Promise<Account> {
    const password = input.password ?? 'e2e-password-1'
    const data = {
      email: input.email ?? uniqueEmail(input.role ?? 'user'),
      fullName: input.fullName ?? unique('Person'),
      role: input.role ?? 'user',
      tenantId: input.tenantId ?? (await this.distributor()).id,
      isActive: input.isActive ?? true,
      password,
    }
    const user = await this.json<User>(await this.ctx.post('/api/users', { data }))
    return { ...user, password }
  }

  async users(tenantId?: string): Promise<User[]> {
    return (await this.json<{ items: User[] }>(await this.ctx.get('/api/users', { params: tenantId ? { tenantId } : {} }))).items
  }

  async createFunctionType(key: string, en: string): Promise<{ id: string }> {
    return this.json(await this.ctx.post('/api/function-types', { data: { key, name: { en } } }))
  }

  async functionType(id: string): Promise<{ id: string; outputKindIds: string[]; knxObjects: unknown[] }> {
    return this.json(await this.ctx.get(`/api/function-types/${id}`))
  }

  /** An active output (channel) kind, after the others. */
  async createOutputKind(key: string, en: string): Promise<{ id: string; key: string; updatedAt: string }> {
    return this.json(await this.ctx.post('/api/output-kinds', { data: { key, name: { en }, isActive: true } }))
  }

  /** Creates a product type; unset fields get defaults (active, no badge). */
  async createProductType(input: Partial<ProductTypeInput> = {}): Promise<ProductType> {
    const key = input.key ?? uniqueKey('pt')
    const data: ProductTypeInput = { key, name: { en: unique('Type') }, isActive: true, ...input }
    return this.json<ProductType>(await this.ctx.post('/api/product-types', { data }))
  }

  /**
   * A project (in the caller's tenant unless tenantId); needs an active product type to exist.
   * currency + exchangeRate (units per 1 USD) give the BOM converted amounts (D228).
   */
  async createProject(
    input: {
      name?: string
      tenantId?: string
      status?: string
      customer?: { name?: string; company?: string }
      currency?: string
      exchangeRate?: string
      productTypeIds?: string[]
    } = {},
  ): Promise<Project> {
    const settings = { currency: input.currency, exchangeRate: input.exchangeRate, productTypeIds: input.productTypeIds }
    const project = await this.json<Project>(
      await this.ctx.post('/api/projects', { data: { name: input.name ?? unique('Project'), tenantId: input.tenantId, customer: input.customer, ...settings } }),
    )
    if (!input.status || input.status === 'active') return project
    return this.json<Project>(
      await this.ctx.put(`/api/projects/${project.id}`, { data: { name: project.name, status: input.status, expectedUpdatedAt: project.updatedAt, ...settings } }),
    )
  }

  async productType(id: string): Promise<ProductType> {
    return this.json<ProductType>(await this.ctx.get(`/api/product-types/${id}`))
  }

  /** Every product type in catalog order, inactive ones included. */
  async productTypes(): Promise<ProductType[]> {
    return (await this.json<{ items: ProductType[] }>(await this.ctx.get('/api/product-types', { params: { includeInactive: true } }))).items
  }

  /**
   * Moves the given product types to the top of the catalog order, in this
   * order. Specs run in parallel and keep creating types (which go to the
   * end), so a type a spec reorders is kept away from the others' this way.
   */
  async moveProductTypesToTop(ids: string[]) {
    for (let attempt = 0; ; attempt++) {
      const rest = (await this.productTypes()).map((t) => t.id).filter((id) => !ids.includes(id))
      const res = await this.ctx.put('/api/product-types/order', { data: { ids: [...ids, ...rest] } })
      if (res.ok()) return
      // Another spec created or deleted a type meanwhile: try again.
      if (res.status() !== 422 || attempt >= 5) expect(res.ok(), `${res.url()}: ${res.status()} ${await res.text()}`).toBe(true)
    }
  }

  /** Replaces a product type with `changes` applied (activation, badge), as the dialog would. */
  async updateProductType(id: string, changes: Partial<ProductTypeInput>): Promise<ProductType> {
    const t = await this.productType(id)
    const current: ProductTypeInput = {
      key: t.key,
      name: t.name,
      ...(t.abbreviation ? { abbreviation: t.abbreviation } : {}),
      ...(t.color ? { color: t.color } : {}),
      isActive: t.isActive,
    }
    const data = { ...current, ...changes, expectedUpdatedAt: t.updatedAt }
    return this.json<ProductType>(await this.ctx.put(`/api/product-types/${id}`, { data }))
  }

  /** Creates a category; unset fields get defaults (active, no attributes). */
  async createCategory(input: Partial<CategoryInput> = {}): Promise<Category> {
    const key = input.key ?? uniqueKey('cat')
    const data: CategoryInput = { key, name: { en: unique('Category') }, isActive: true, attributes: [], instanceAttributes: [], ...input }
    return this.json<Category>(await this.ctx.post('/api/categories', { data }))
  }

  async category(id: string): Promise<Category> {
    return this.json<Category>(await this.ctx.get(`/api/categories/${id}`))
  }

  /** Every category in catalog order, inactive ones included. */
  async categories(): Promise<Category[]> {
    return (await this.json<{ items: Category[] }>(await this.ctx.get('/api/categories', { params: { includeInactive: true } }))).items
  }

  /** Moves the given categories to the top of the catalog order (see moveProductTypesToTop). */
  async moveCategoriesToTop(ids: string[]) {
    for (let attempt = 0; ; attempt++) {
      const rest = (await this.categories()).map((c) => c.id).filter((id) => !ids.includes(id))
      const res = await this.ctx.put('/api/categories/order', { data: { ids: [...ids, ...rest] } })
      if (res.ok()) return
      if (res.status() !== 422 || attempt >= 5) expect(res.ok(), `${res.url()}: ${res.status()} ${await res.text()}`).toBe(true)
    }
  }

  /** Replaces a category with `changes` applied (activation, schema), as the editor would. */
  async updateCategory(id: string, changes: Partial<CategoryInput>): Promise<Category> {
    const c = await this.category(id)
    const current: CategoryInput = {
      key: c.key,
      name: c.name,
      ...(c.description ? { description: c.description } : {}),
      isActive: c.isActive,
      attributes: c.attributes,
      instanceAttributes: c.instanceAttributes,
    }
    const data = { ...current, ...changes, expectedUpdatedAt: c.updatedAt }
    return this.json<Category>(await this.ctx.put(`/api/categories/${id}`, { data }))
  }

  /** A new product type and a new category (with the schema), for products of their own. */
  async createKind(category: Partial<CategoryInput> = {}, type: Partial<ProductTypeInput> = {}): Promise<Kind> {
    const [t, c] = await Promise.all([this.createProductType(type), this.createCategory(category)])
    return { type: t, category: c, ids: { productTypeId: t.id, categoryId: c.id } }
  }

  /** Creates a product; unset fields get defaults (a unique model number, active). */
  async createProduct(input: Partial<ProductInput> & { productTypeId: string; categoryId: string }): Promise<Product> {
    const data = { modelNumber: unique('M').replace(/\s+/g, '-'), name: { en: unique('Product') }, isActive: true, attributes: {}, ...input }
    const product = await this.json<Product>(await this.ctx.post('/api/products', { data }))
    if (input.firstVariant) return product
    // Without firstVariant the API adds a "Standard" variant (D449); the specs add their variants with createVariant, so it goes again.
    for (const v of product.variants) {
      const res = await this.ctx.delete(`/api/products/${product.id}/variants/${v.id}`)
      expect(res.ok(), `delete the default variant: ${res.status()} ${await res.text()}`).toBe(true)
    }
    return { ...product, variants: [] }
  }

  async product(id: string): Promise<Product> {
    return this.json<Product>(await this.ctx.get(`/api/products/${id}`))
  }

  /** Replaces a product with `changes` applied. */
  async updateProduct(id: string, changes: Partial<ProductInput>): Promise<Product> {
    const p = await this.product(id)
    const data = {
      productTypeId: p.productTypeId,
      categoryId: p.categoryId,
      modelNumber: p.modelNumber,
      name: p.name,
      ...(p.description ? { description: p.description } : {}),
      attributes: { ...p.attributes, ...p.staleAttributes },
      isActive: p.isActive,
      ...changes,
      expectedUpdatedAt: p.updatedAt,
    }
    return this.json<Product>(await this.ctx.put(`/api/products/${id}`, { data }))
  }

  /** Creates a variant; unset fields get defaults (price 10.00, active). */
  async createVariant(productId: string, input: Partial<VariantInput> = {}): Promise<Variant> {
    const data = { name: { en: unique('Variant') }, price: '10.00', isActive: true, attributes: {}, ...input }
    return this.json<Variant>(await this.ctx.post(`/api/products/${productId}/variants`, { data }))
  }

  async replaceAddons(productId: string, variantId: string, addons: { addonVariantId: string; required?: boolean }[]): Promise<Variant> {
    return this.json<Variant>(await this.ctx.put(`/api/products/${productId}/variants/${variantId}/addons`, { data: { addons } }))
  }

  /** Uploads an image file (bytes) as the catalog would. */
  async uploadFile(name: string, mimeType: string, buffer: Buffer): Promise<StoredFile> {
    return this.json<StoredFile>(await this.ctx.post('/api/files', { multipart: { file: { name, mimeType, buffer } } }))
  }

  /** Adds a plan with an image to a version (multipart, as the Add plan dialog). */
  async createPlan(versionId: string, name: string, image: { name: string; mimeType: string; buffer: Buffer }): Promise<{ id: string; name: string }> {
    return this.json(await this.ctx.post(`/api/versions/${versionId}/plans`, { multipart: { name, image } }))
  }

  /** The stored content of a plan. */
  async planContent(planId: string): Promise<PlanContent> {
    return this.json<PlanContent>(await this.ctx.get(`/api/plans/${planId}/content`))
  }

  /** Saves a plan's content as the editor does: take the lock, save against the current content, release the lock. */
  async savePlanContent(
    planId: string,
    content: {
      zones?: PlanContent['zones']
      placements: { variantId: string; x: number; y: number; existing?: boolean }[]
      /** Needs as `PlanContent['needs']` without ids and defaults: `{ functionTypeId, quantity, zoneId | x/y, ... }`. */
      needs?: (Partial<PlanContent['needs'][number]> & { functionTypeId: string })[]
    },
  ): Promise<void> {
    await this.json(await this.ctx.post(`/api/plans/${planId}/lock`))
    const current = await this.json<{ contentUpdatedAt: string }>(await this.ctx.get(`/api/plans/${planId}/content`))
    const placements = content.placements.map((p) => ({
      id: crypto.randomUUID(),
      width: 40,
      height: 40,
      rotation: 0,
      label: '',
      instanceValues: {},
      addonVariantIds: [],
      existing: false,
      ...p,
    }))
    await this.json(
      await this.ctx.put(`/api/plans/${planId}/content`, {
        data: {
          expectedContentUpdatedAt: current.contentUpdatedAt,
          scale: null,
          zones: content.zones ?? [],
          placements,
          needs: (content.needs ?? []).map((n) => ({
            id: crypto.randomUUID(),
            zoneId: null,
            quantity: 1,
            powerW: null,
            loadTypeId: null,
            label: '',
            note: '',
            x: null,
            y: null,
            ...n,
          })),
        },
      }),
    )
    await this.ctx.delete(`/api/plans/${planId}/lock`)
  }

  /** Changes a variant's price as the catalog editor would. */
  async setVariantPrice(productId: string, variant: Variant, price: string): Promise<Variant> {
    const { name, sku, imageFileId, attributes, isActive, updatedAt } = variant
    return this.json<Variant>(
      await this.ctx.put(`/api/products/${productId}/variants/${variant.id}`, {
        data: { name, sku, imageFileId, attributes, isActive, price, expectedUpdatedAt: updatedAt },
      }),
    )
  }

  /** Adds a manual BOM line: a catalog variant, or free text with a USD unit price. */
  async addManualLine(versionId: string, line: { variantId?: string; name?: string; unitPrice?: string; quantity: number; note?: string }): Promise<{ id: string }> {
    return this.json(await this.ctx.post(`/api/versions/${versionId}/manual-lines`, { data: line }))
  }

  /** Saves a version's pricing (discount, services, label) over whatever it has. */
  async savePricing(
    versionId: string,
    pricing: {
      discountKind: string
      discountValue?: string
      servicesKind: string
      servicesValue?: string
      servicesLabel?: Localized
      introText?: Localized
      closingText?: Localized
    },
  ): Promise<void> {
    const current = await this.json<{ updatedAt: string | null }>(await this.ctx.get(`/api/versions/${versionId}/pricing`))
    await this.json(
      await this.ctx.put(`/api/versions/${versionId}/pricing`, {
        data: { discountValue: '0', servicesValue: '0', ...pricing, expectedUpdatedAt: current.updatedAt },
      }),
    )
  }

  async dispose() {
    await this.ctx.dispose()
  }
}

/** Opens a fresh browser context (own cookies) for another user, signed in through the API. */
export async function signedInPage(browser: Browser, account: { email: string; password: string }): Promise<{ context: BrowserContext; page: Page }> {
  const { context, page } = await anonymousPage(browser)
  const res = await context.request.post('/api/auth/login', { data: { email: account.email, password: account.password } })
  expect(res.status(), await res.text()).toBe(200)
  return { context, page }
}

/** Opens a fresh browser context without a session. */
export async function anonymousPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: frontendURL, locale: 'en-US', storageState: { cookies: [], origins: [] } })
  return { context, page: await context.newPage() }
}

/** Signs in through the login form. */
export async function signIn(page: Page, email: string, password: string) {
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

type Fixtures = {
  /** API client signed in as the e2e admin (for seeding). */
  api: Api
  /** Opens extra signed-in browser sessions; closed after the test. */
  sessionFor: (account: { email: string; password: string }) => Promise<Page>
  /** Opens extra anonymous browser sessions; closed after the test. */
  anonymous: () => Promise<Page>
}

export const test = base.extend<Fixtures>({
  api: async ({}, use) => {
    const api = await Api.login(admin.email, admin.password)
    await use(api)
    await api.dispose()
  },
  sessionFor: async ({ browser }, use) => {
    const contexts: BrowserContext[] = []
    await use(async (account) => {
      const { context, page } = await signedInPage(browser, account)
      contexts.push(context)
      return page
    })
    await Promise.all(contexts.map((c) => c.close()))
  },
  anonymous: async ({ browser }, use) => {
    const contexts: BrowserContext[] = []
    await use(async () => {
      const { context, page } = await anonymousPage(browser)
      contexts.push(context)
      return page
    })
    await Promise.all(contexts.map((c) => c.close()))
  },
})

/** The main navigation in the app header (desktop; on phones it sits in the menu sheet). */
export const nav = (page: Page) => page.getByRole('navigation', { name: /^(Main navigation|Hauptnavigation)$/ })

/**
 * Opens a page through the grouped navigation (D97): a section with several
 * pages is a menu, a section with one page a plain link.
 */
export async function navigate(page: Page, section: string, item: string) {
  const link = nav(page).getByRole('link', { name: item, exact: true })
  if ((await link.count()) > 0) return link.click()
  await nav(page).getByRole('button', { name: section, exact: true }).click()
  await page.getByRole('menu', { name: section }).getByRole('menuitem', { name: item, exact: true }).click()
}

/** What the navigation offers: per section menu its pages, per plain link its own name. */
export async function navEntries(page: Page): Promise<Record<string, string[]>> {
  await expect(nav(page)).toBeVisible()
  const entries: Record<string, string[]> = {}
  for (const entry of await nav(page).locator(':scope > *').all()) {
    const name = (await entry.textContent())?.trim() ?? ''
    if ((await entry.getAttribute('aria-haspopup')) === 'menu') {
      await entry.click()
      const menu = page.getByRole('menu', { name })
      entries[name] = (await menu.getByRole('menuitem').allTextContents()).map((t) => t.trim())
      await page.keyboard.press('Escape')
      await expect(menu).toBeHidden()
    } else {
      entries[name] = [name]
    }
  }
  return entries
}

/** The user menu button in the header ("Account: name"). */
export const accountButton = (page: Page) => page.getByRole('banner').getByRole('button', { name: /^(Account|Konto): / })

/** Opens the user menu and returns it. */
export async function userMenu(page: Page) {
  await accountButton(page).click()
  return page.getByRole('menu')
}

export async function signOut(page: Page) {
  await (await userMenu(page)).getByRole('menuitem', { name: /^(Sign out|Abmelden)$/ }).click()
}

/** Switches the UI language in the user menu, e.g. to "Deutsch". */
export async function chooseLanguage(page: Page, language: string) {
  await (await userMenu(page)).getByRole('menuitemradio', { name: language }).click()
  await page.keyboard.press('Escape')
}

/** The option texts a design-system Select offers; opens it and closes it again. */
export async function optionTexts(select: Locator): Promise<string[]> {
  await select.click()
  const listbox = select.page().getByRole('listbox')
  await expect(listbox).toBeVisible()
  const texts = (await listbox.getByRole('option').allTextContents()).map((t) => t.trim())
  await select.page().keyboard.press('Escape')
  await expect(listbox).toBeHidden()
  return texts
}

/** Picks an option of a design-system Select (a combobox button, not a native select). */
export async function chooseOption(select: Locator, label: string) {
  await select.click()
  await select.page().getByRole('option', { name: label, exact: true }).click()
}

/** A table row containing the given text. */
export const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text })

/**
 * The input of one language of a TranslatableField (D109): shows that
 * language's tab and returns its input, e.g.
 * `await (await translation(dialog, 'Name', 'de')).fill('Dimmer')`. `ui` is
 * the interface language, which names the tabs and the list of them. The
 * first such field in `scope` is used (a card's own before its options').
 */
export async function translation(scope: Locator | Page, label: string, language: 'en' | 'de', ui: 'en' | 'de' = 'en'): Promise<Locator> {
  const list = ui === 'de' ? `Übersetzungen von ${label}` : `Translations of ${label}`
  const page = 'page' in scope ? scope.page() : scope
  const field = scope.locator('[data-translatable]').filter({ has: page.getByRole('tablist', { name: list, exact: true }) }).first()
  const tab = field.getByRole('tab', { name: new Intl.DisplayNames([ui], { type: 'language' }).of(language), exact: true })
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  return field.getByLabel(label, { exact: true })
}

/** Chooses an entry of a card's "⋯" menu (Move to top/bottom, Insert below, Duplicate, Remove; D114). */
export async function cardAction(card: Locator, action: string) {
  await card.getByRole('button', { name: /^(More actions for|Weitere Aktionen für) / }).click()
  await card.page().getByRole('menuitem', { name: action, exact: true }).click()
}
