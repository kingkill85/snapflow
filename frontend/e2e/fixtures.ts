import { type APIRequestContext, type Browser, type BrowserContext, expect, type Page, request, test as base } from '@playwright/test'

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
export type ProductTypeInput = {
  key: string
  name: Localized
  description?: Localized
  color?: string
  isActive: boolean
  attributes: Attribute[]
  instanceAttributes: Omit<Attribute, 'scope'>[]
}
export type ProductType = ProductTypeInput & { id: string; sortOrder: number; updatedAt: string }
export type ProductInput = {
  productTypeId: string
  modelNumber: string
  name: Localized
  description?: Localized
  attributes?: Record<string, unknown>
  isActive?: boolean
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
export type Product = Required<Pick<ProductInput, 'productTypeId' | 'modelNumber' | 'name' | 'attributes' | 'isActive'>> &
  Pick<ProductInput, 'description'> & {
    id: string
    staleAttributes: Record<string, unknown>
    available: boolean
    variants: Variant[]
    variantsWithProblems: number
    updatedAt: string
  }
export type StoredFile = { id: string; contentType: string; size: number; width: number; height: number; sha256: string }
/** A user created by a spec, with the password it signs in with. */
export type Account = User & { password: string }

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

  /** Creates a product type; unset fields get defaults (active, no attributes). */
  async createProductType(input: Partial<ProductTypeInput> = {}): Promise<ProductType> {
    const key = input.key ?? uniqueKey('pt')
    const data: ProductTypeInput = { key, name: { en: unique('Type') }, isActive: true, attributes: [], instanceAttributes: [], ...input }
    return this.json<ProductType>(await this.ctx.post('/api/product-types', { data }))
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

  /** Replaces a product type with `changes` applied (activation, schema), as the editor would. */
  async updateProductType(id: string, changes: Partial<ProductTypeInput>): Promise<ProductType> {
    const t = await this.productType(id)
    const current: ProductTypeInput = {
      key: t.key,
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.color ? { color: t.color } : {}),
      isActive: t.isActive,
      attributes: t.attributes,
      instanceAttributes: t.instanceAttributes,
    }
    const data = { ...current, ...changes, expectedUpdatedAt: t.updatedAt }
    return this.json<ProductType>(await this.ctx.put(`/api/product-types/${id}`, { data }))
  }

  /** Creates a product; unset fields get defaults (a unique model number, active). */
  async createProduct(input: Partial<ProductInput> & { productTypeId: string }): Promise<Product> {
    const data = { modelNumber: unique('M').replace(/\s+/g, '-'), name: { en: unique('Product') }, isActive: true, attributes: {}, ...input }
    return this.json<Product>(await this.ctx.post('/api/products', { data }))
  }

  async product(id: string): Promise<Product> {
    return this.json<Product>(await this.ctx.get(`/api/products/${id}`))
  }

  /** Replaces a product with `changes` applied. */
  async updateProduct(id: string, changes: Partial<ProductInput>): Promise<Product> {
    const p = await this.product(id)
    const data = {
      productTypeId: p.productTypeId,
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

/** The main navigation in the app header. */
export const nav = (page: Page) => page.getByRole('navigation')

/** A table row containing the given text. */
export const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text })
