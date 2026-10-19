import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from '@playwright/test'

import { type Api, expect, test, unique } from '../fixtures'

// Online exchange rates (D272–D282): the currency combobox, the rate field of
// the edit dialog in every state, the rate bar on the BOM and Pricing tabs in
// every state, and the proposals notice without a rate, at phone, tablet and
// desktop width, light and dark, English and German. Screenshots land in
// e2e/screenshots/rates-*.png; one proposal (manual rate, a manual line with a
// note, model numbers with hyphens) lands in e2e/screenshots/rates-docs/ to be
// converted with LibreOffice. The provider is the e2e stub (EUR 0.9237, dated
// yesterday; no JPY). Tagged @visual: it runs with `make e2e-visual`.

const viewports = [
  { name: 'phone', size: { width: 390, height: 844 } },
  { name: 'tablet', size: { width: 768, height: 1024 } },
  { name: 'desktop', size: { width: 1280, height: 800 } },
]

const labels = {
  en: { newProject: 'New project', editProject: 'Edit project', currency: 'Currency', rate: 'Exchange rate', update: 'Update', fetch: 'Fetch current rate' },
  de: { newProject: 'Neues Projekt', editProject: 'Projekt bearbeiten', currency: 'Währung', rate: 'Wechselkurs', update: 'Aktualisieren', fetch: 'Aktuellen Kurs abrufen' },
}

const docsDir = join(import.meta.dirname, '../screenshots/rates-docs')

type Project = { id: string; name: string; updatedAt: string; versions: { id: string }[] }

async function ok<T>(res: Awaited<ReturnType<Api['ctx']['get']>>): Promise<T> {
  expect(res.ok(), `${res.url()}: ${res.status()} ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'page is wider than the viewport').toBeLessThanOrEqual(0)
}

/** Projects in every rate state, each with a catalog line and a manual line with a note. */
async function seed(api: Api, lang: 'en' | 'de', suffix: string) {
  const kind = await api.createKind(
    { name: { en: 'Switches', de: 'Schalter' } },
    { name: { en: unique('Zigbee'), de: unique('Zigbee') }, abbreviation: 'ZB', color: '#1f6feb' },
  )
  const model = `ZB-SW2-PRO-${suffix}`
  const product = await api.createProduct({ ...kind.ids, modelNumber: model, name: { en: 'Wall switch 2-gang with status LED', de: 'Wandschalter 2-fach mit Status-LED' } })
  const variant = await api.createVariant(product.id, { name: { en: 'White', de: 'Weiß' }, sku: `${model}-WH-01`, price: '49.90' })
  const project = async (name: string, currency: string) => {
    const p = (await api.createProject({ name: unique(name), currency, productTypeIds: [kind.type.id] })) as unknown as Project
    const versionId = p.versions[0].id
    await api.addManualLine(versionId, { variantId: variant.id, quantity: 4 })
    await api.addManualLine(versionId, {
      name: lang === 'de' ? 'Inbetriebnahme vor Ort' : 'Commissioning on site',
      unitPrice: '120.00',
      quantity: 2,
      note: lang === 'de' ? 'Zwei Termine, je ein halber Tag; Anfahrt inklusive.' : 'Two visits, half a day each; travel included.',
    })
    return { ...p, versionId }
  }
  const refresh = async (p: Project) => ok<Project>(await api.ctx.post(`/api/projects/${p.id}/exchange-rate/refresh`, { data: { currency: 'EUR' } }))
  const de = lang === 'de'
  const none = await project(de ? 'Haus ohne Kurs' : 'House without rate', 'EUR')
  const online = await project(de ? 'Villa Online-Kurs' : 'Villa online rate', 'EUR')
  await refresh(online)
  const stale = await project(de ? 'Altbau alter Kurs' : 'Old building stale rate', 'EUR')
  await refresh(stale)
  const manual = await project(de ? 'Büro vereinbarter Kurs' : 'Office agreed rate', 'EUR')
  await ok(await api.ctx.put(`/api/projects/${manual.id}/exchange-rate`, { data: { rate: '0.95', currency: 'EUR' } }))
  const done = await project(de ? 'Abgeschlossen Krüger' : 'Completed Krüger', 'EUR')
  const d = await refresh(done)
  await ok(await api.ctx.put(`/api/projects/${done.id}`, { data: { name: d.name, status: 'completed', expectedUpdatedAt: d.updatedAt } }))
  const jpy = await project(de ? 'Tokio ohne Online-Kurs' : 'Tokyo no online rate', 'JPY')
  return { none, online, stale, manual, done, jpy }
}

/** Makes the project look 12 days old online (the stub always dates yesterday). */
async function ageRate(page: Page, projectId: string) {
  await page.route(`**/api/projects/${projectId}`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const res = await route.fetch()
    const json = (await res.json()) as Record<string, unknown>
    const old = new Date()
    old.setUTCDate(old.getUTCDate() - 12)
    await route.fulfill({ response: res, json: { ...json, exchangeRateDate: old.toISOString(), exchangeRateStale: true, exchangeRateAgeDays: 12 } })
  })
}

test('a proposal with a manual rate, a manual line note and model numbers with hyphens', { tag: '@visual' }, async ({ api }) => {
  const s = await seed(api, 'de', 'DOC')
  const res = await api.ctx.post(`/api/versions/${s.manual.versionId}/proposals`, { data: { exporter: 'docx' } })
  const proposals = await ok<{ fileName: string; downloadUrl: string }[]>(res)
  mkdirSync(docsDir, { recursive: true })
  for (const p of proposals) {
    const file = await api.ctx.get(p.downloadUrl)
    expect(file.ok()).toBe(true)
    writeFileSync(join(docsDir, p.fileName), await file.body())
  }
})

for (const lang of ['en', 'de'] as const) {
  for (const viewport of viewports) {
    test(`exchange rates fit the screen: ${viewport.name}, ${lang}`, { tag: '@visual' }, async ({ page, api }) => {
      test.setTimeout(600_000)
      const l = labels[lang]
      const s = await seed(api, lang, `${viewport.name}-${lang}`.toUpperCase())
      const dialog = page.getByRole('dialog')
      const tab = (id: string, name: 'bom' | 'pricing' | 'proposals') => `/projects/${id}?tab=${name}`
      const openEdit = async () => {
        await page.getByRole('button', { name: l.editProject }).click()
        await dialog.getByLabel(l.rate, { exact: true }).scrollIntoViewIfNeeded()
      }
      const rateField = () => dialog.getByLabel(l.rate, { exact: true })

      type Step = { name: string; path: string; fullPage?: boolean; route?: () => Promise<unknown>; act?: () => Promise<void> }
      const steps: Step[] = [
        {
          name: 'create-currency',
          path: '/projects',
          act: async () => {
            await page.getByRole('button', { name: l.newProject }).click()
            const box = dialog.getByRole('combobox', { name: l.currency })
            await box.scrollIntoViewIfNeeded()
            await box.click()
            await expect(page.getByRole('listbox')).toBeVisible()
          },
        },
        {
          name: 'create-currency-search',
          path: '/projects',
          act: async () => {
            await page.getByRole('button', { name: l.newProject }).click()
            const box = dialog.getByRole('combobox', { name: l.currency })
            await box.scrollIntoViewIfNeeded()
            await box.fill('rup')
            await page.keyboard.press('ArrowDown')
            await expect(page.getByRole('option').first()).toBeVisible()
          },
        },
        { name: 'edit-online', path: `/projects/${s.online.id}`, act: openEdit },
        { name: 'edit-manual', path: `/projects/${s.manual.id}`, act: openEdit },
        { name: 'edit-none', path: `/projects/${s.none.id}`, act: openEdit },
        { name: 'edit-no-online', path: `/projects/${s.jpy.id}`, act: openEdit },
        {
          name: 'edit-implausible',
          path: `/projects/${s.online.id}`,
          act: async () => {
            // Only a manual rate of a new currency is checked: EUR -> PKR (278.5 online), typed 100x off.
            await openEdit()
            await dialog.getByRole('combobox', { name: l.currency }).fill('PKR')
            await page.keyboard.press('Enter')
            await expect(rateField()).not.toHaveValue('')
            await rateField().fill(lang === 'de' ? '2,785' : '2.785')
            await dialog.getByRole('button', { name: l.update, exact: true }).click()
            await expect(rateField()).toHaveAttribute('aria-invalid', 'true')
            await rateField().scrollIntoViewIfNeeded()
          },
        },
        {
          name: 'edit-fetch-failed',
          path: `/projects/${s.online.id}`,
          route: () =>
            page.route('**/api/exchange-rates/EUR', (r) =>
              r.fulfill({ status: 503, json: { code: 'exchange_rate.unavailable', title: 'Service Unavailable', status: 503 } }),
            ),
          act: async () => {
            await openEdit()
            await dialog.getByRole('button', { name: l.fetch }).click()
            await expect(dialog.getByRole('alert').first()).toBeVisible()
            await dialog.getByRole('alert').first().scrollIntoViewIfNeeded()
          },
        },
        { name: 'bom-none', path: tab(s.none.id, 'bom'), fullPage: true },
        { name: 'bom-online', path: tab(s.online.id, 'bom'), fullPage: true },
        { name: 'bom-stale', path: tab(s.stale.id, 'bom'), fullPage: true, route: () => ageRate(page, s.stale.id) },
        { name: 'bom-manual', path: tab(s.manual.id, 'bom'), fullPage: true },
        { name: 'bom-read-only', path: tab(s.done.id, 'bom'), fullPage: true },
        { name: 'pricing-none', path: tab(s.none.id, 'pricing'), fullPage: true },
        { name: 'pricing-online', path: tab(s.online.id, 'pricing'), fullPage: true },
        { name: 'pricing-stale', path: tab(s.stale.id, 'pricing'), fullPage: true, route: () => ageRate(page, s.stale.id) },
        { name: 'pricing-manual', path: tab(s.manual.id, 'pricing'), fullPage: true },
        { name: 'pricing-read-only', path: tab(s.done.id, 'pricing'), fullPage: true },
        {
          name: 'pricing-set-rate',
          path: tab(s.manual.id, 'pricing'),
          act: async () => {
            await page.getByTestId('rate-bar').getByRole('button').last().click()
            await expect(dialog).toBeVisible()
          },
        },
        { name: 'proposals-rate-missing', path: tab(s.none.id, 'proposals'), fullPage: true },
      ]

      await page.addInitScript((lng) => window.localStorage.setItem('i18nextLng', lng), lang)
      await page.setViewportSize(viewport.size)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        for (const step of steps) {
          if (step.route) await step.route()
          await page.goto(step.path)
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
          await page.waitForLoadState('networkidle').catch(() => {})
          if (step.act) await step.act()
          await page.waitForTimeout(250)
          await expectNoHorizontalOverflow(page)
          await page.screenshot({ path: `e2e/screenshots/rates-${step.name}-${viewport.name}-${colorScheme}-${lang}.png`, fullPage: step.fullPage ?? false })
          await page.keyboard.press('Escape')
          if (step.route) await page.unrouteAll({ behavior: 'ignoreErrors' })
        }
      }
    })
  }
}
