import { type APIRequestContext, type Browser, type BrowserContext, expect, type Page, request, test as base } from '@playwright/test'

import { admin, backendURL, frontendURL } from './env'

export { expect }

export type Role = 'admin' | 'tenant_admin' | 'user'
export type Tenant = { id: string; name: string; isDistributor: boolean; isActive: boolean }
export type User = { id: string; email: string; fullName: string; role: Role; tenantId: string; isActive: boolean }
/** A user created by a spec, with the password it signs in with. */
export type Account = User & { password: string }

let counter = 0
/** A name no other spec (or earlier run) uses, e.g. "Tenant k3x9a1-2". */
export function unique(prefix: string): string {
  counter += 1
  return `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}-${counter}`
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
