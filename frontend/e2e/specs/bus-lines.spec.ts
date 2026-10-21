import { type Page } from '@playwright/test'

import { boardCatalog } from '../boards-catalog'
import { type Api, expect, test, unique } from '../fixtures'

// Step 4b-2 (D451, D452): the first bus line appears by itself ("Linie 1" in a
// German project), its devices are members by default, its Delete stays
// disabled while it is the system's last line with devices, and the server
// refuses that delete for a stale page too.

type Catalog = Awaited<ReturnType<typeof boardCatalog>>

async function json<T>(res: { ok(): boolean; text(): Promise<string>; json(): Promise<unknown> }): Promise<T> {
  expect(res.ok(), await res.text()).toBe(true)
  return (await res.json()) as T
}

/** A project in `language` with a KNX board holding a power supply and an actuator, saved once (the save creates the line). */
async function seed(api: Api, c: Catalog, language: 'en' | 'de') {
  const project = await json<{ id: string; versions: { id: string }[] }>(
    await api.ctx.post('/api/projects', { data: { name: unique(language === 'de' ? 'Haus Bergmann' : 'House Bergman'), language, productTypeIds: [c.knx.id] } }),
  )
  const versionId = project.versions[0].id
  const board = await json<{ id: string }>(await api.ctx.post(`/api/versions/${versionId}/boards`, { data: { name: language === 'de' ? 'Hauptverteiler' : 'Main board', enclosureVariantId: c.enclosure.variantId } }))
  await json(await api.ctx.post(`/api/plans/${board.id}/lock`))
  const content = await json<{ contentUpdatedAt: string; enclosureVariantId: string | null; rows: { id: string; capacityTe: number }[] }>(await api.ctx.get(`/api/plans/${board.id}/board`))
  const row = content.rows[0].id
  const mod = (variantId: string, offsetTe: number) => ({ id: crypto.randomUUID(), variantId, rowId: row, offsetTe, label: '', existing: false, addonVariantIds: [], instanceValues: {} })
  await json(
    await api.ctx.put(`/api/plans/${board.id}/board`, {
      data: {
        expectedContentUpdatedAt: content.contentUpdatedAt,
        enclosureVariantId: content.enclosureVariantId,
        rows: content.rows.map((r) => ({ id: r.id, capacityTe: r.capacityTe })),
        modules: [mod(c.psu.variantId, 0), mod(c.actuator.variantId, 2)],
      },
    }),
  )
  await api.ctx.delete(`/api/plans/${board.id}/lock`)
  return { project, versionId, board }
}

async function lines(api: Api, versionId: string) {
  return json<{ id: string; name: string }[]>(await api.ctx.get(`/api/versions/${versionId}/bus-lines`))
}

test('bus lines: automatic "Linie 1", default members, last-line delete refused, a second line by hand', async ({ page, api }) => {
  test.setTimeout(90_000)
  const c = await boardCatalog(api)
  const s = await seed(api, c, 'de')
  await page.addInitScript(() => window.localStorage.setItem('i18nextLng', 'de'))
  await page.setViewportSize({ width: 1400, height: 900 })

  // The API: one line named in the project's language; deleting it is refused while the board holds its devices.
  const [only] = await lines(api, s.versionId)
  expect(only.name).toBe('Linie 1')
  const refused = await api.ctx.delete(`/api/versions/${s.versionId}/bus-lines/${only.id}`)
  expect(refused.status()).toBe(409)
  const body = (await refused.json()) as { code: string; params: { count: number } }
  expect(body.code).toBe('bus_line.last_with_devices')
  expect(body.params.count).toBe(2)

  // Networks: "Linie 1" with both modules as "Standard"; Delete disabled with the reason.
  await page.goto(`/projects/${s.project.id}?tab=networks`)
  const knx = page.getByRole('region', { name: /KNX/ })
  const first = knx.getByRole('table', { name: 'Linie 1' })
  await expect(first.getByRole('row').filter({ hasText: c.psu.name })).toContainText('Standard')
  await expect(first.getByRole('row').filter({ hasText: c.actuator.name })).toContainText('Standard')
  const del1 = knx.getByRole('button', { name: 'Linie 1 löschen' })
  await expect(del1).toBeDisabled()
  await expect(del1).toHaveAttribute('title', /letzte Linie eines Systems mit Geräten/)

  // A second line by hand: now Linie 1 may go.
  await knx.getByRole('button', { name: 'Linie hinzufügen' }).click()
  const dialog = page.getByRole('dialog', { name: 'Neue Linie' })
  await dialog.getByLabel('Name').fill('KNX 2')
  await dialog.getByLabel('Adresse').fill('1.2')
  await dialog.getByRole('button', { name: 'Erstellen' }).click()
  await expect(dialog).toBeHidden()
  await expect(knx.getByRole('heading', { name: 'KNX 2', exact: true })).toBeVisible()
  await expect(del1).toBeEnabled()
  await expect(knx.getByRole('button', { name: 'KNX 2 löschen' })).toBeEnabled()

  // A stale page: another session deletes "KNX 2"; deleting "Linie 1" here is refused with the translated reason.
  const second = (await lines(api, s.versionId)).find((l) => l.name === 'KNX 2')!
  const gone = await api.ctx.delete(`/api/versions/${s.versionId}/bus-lines/${second.id}`)
  expect(gone.ok(), await gone.text()).toBe(true)
  await del1.click()
  const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: 'Linie löschen?' }))
  await confirm.getByRole('button', { name: 'Löschen' }).click()
  await expect(confirm.getByText('Das ist die letzte Linie des Systems, und 2 Geräte sind auf den Plänen.', { exact: false })).toBeVisible()
  await confirm.getByRole('button', { name: 'Abbrechen' }).click()
  await page.reload()
  await expect(knx.getByRole('heading', { name: 'KNX 2', exact: true })).toHaveCount(0)
  await expect(del1).toBeDisabled()

  // The second line again, the actuator pinned to it.
  await knx.getByRole('button', { name: 'Linie hinzufügen' }).click()
  await dialog.getByLabel('Name').fill('KNX 2')
  await dialog.getByLabel('Adresse').fill('1.2')
  await dialog.getByRole('button', { name: 'Erstellen' }).click()
  await expect(dialog).toBeHidden()
  await knx.getByRole('combobox', { name: new RegExp(`^Linie von ${c.actuator.name}`) }).click()
  await page.getByRole('option', { name: 'KNX 2' }).click()
  const line2 = knx.getByRole('table', { name: 'KNX 2' })
  await expect(line2.getByRole('row').filter({ hasText: c.actuator.name })).toContainText('Fest')
  await expect(first.getByRole('row').filter({ hasText: c.psu.name })).toContainText('Standard')

  // Checks: each line's power supply state.
  await page.getByRole('tab', { name: 'Prüfungen' }).click()
  await expect(page.getByText('Buslinie Linie 1')).toBeVisible()
  await expect(page.getByText('Buslinie KNX 2')).toBeVisible()
  await expect(page.getByText('KNX 2: keine Spannungsversorgung')).toBeVisible()
})

// The screenshots of 4b-2 for the visual review (make e2e-visual).
const viewports = [
  { name: 'phone', size: { width: 390, height: 844 } },
  { name: 'tablet', size: { width: 768, height: 1024 } },
  { name: 'desktop', size: { width: 1280, height: 800 } },
]

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'page is wider than the viewport').toBeLessThanOrEqual(0)
}

async function shot(page: Page, file: string, fullPage = true) {
  await page.waitForLoadState('networkidle')
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: `e2e/screenshots/${file}.png`, fullPage })
}

for (const lang of ['en', 'de'] as const) {
  test(`bus lines fit the screen: ${lang}`, { tag: '@visual' }, async ({ page, api }) => {
    test.setTimeout(300_000)
    const c = await boardCatalog(api)
    const one = await seed(api, c, lang)
    const two = await seed(api, c, lang)
    await json(await api.ctx.post(`/api/versions/${two.versionId}/bus-lines`, { data: { productTypeId: c.knx.id, name: 'KNX 2', address: '1.2' } }))
    const lineName = lang === 'de' ? 'Linie 1' : 'Line 1'
    const deleteName = lang === 'de' ? `${lineName} löschen` : `Delete ${lineName}`
    await page.addInitScript((l) => window.localStorage.setItem('i18nextLng', l), lang)
    for (const viewport of viewports) {
      await page.setViewportSize(viewport.size)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        await page.goto(`/projects/${one.project.id}?tab=networks`)
        await expect(page.getByRole('heading', { name: lineName, exact: true })).toBeVisible()
        await shot(page, `bus-lines-default-${viewport.name}-${colorScheme}-${lang}`)
        if (viewport.name === 'desktop') {
          const del = page.getByRole('button', { name: deleteName })
          await expect(del).toBeDisabled()
          await del.hover({ force: true })
          await page.waitForTimeout(1500)
          await shot(page, `bus-lines-delete-hover-${viewport.name}-${colorScheme}-${lang}`, false)
        }
        await page.goto(`/projects/${two.project.id}?tab=networks`)
        await expect(page.getByRole('heading', { name: 'KNX 2', exact: true })).toBeVisible()
        await shot(page, `bus-lines-two-lines-${viewport.name}-${colorScheme}-${lang}`)
      }
    }
  })
}
