import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from '@playwright/test'

import { boardCatalog } from '../boards-catalog'
import { type Api, expect, test, unique } from '../fixtures'

// The board editor, the Add board dialog, board cards and the Networks tab
// (step 3c) at phone, tablet and desktop width, light and dark, English and
// German: nothing overflows the viewport (D107). Screenshots land in
// e2e/screenshots/boards-*.png. Tagged @visual: it runs with `make e2e-visual`.

const assets = join(import.meta.dirname, '../assets')
const planImage = () => ({ name: 'floorplan.png', mimeType: 'image/png', buffer: readFileSync(join(assets, 'floorplan.png')) })

const viewports = [
  { name: 'phone', size: { width: 390, height: 844 }, wide: false },
  { name: 'tablet', size: { width: 768, height: 1024 }, wide: true },
  { name: 'desktop', size: { width: 1280, height: 800 }, wide: true },
]

const labels = {
  en: { addBoard: 'Add board', saved: 'Saved', board: 'Board', inspector: 'Inspector', networks: 'Networks', boardName: 'Main distribution board' },
  de: { addBoard: 'Verteiler hinzufügen', saved: 'Gespeichert', board: 'Verteiler', inspector: 'Eigenschaften', networks: 'Netzwerke', boardName: 'Hauptverteiler im Keller' },
}
type Lang = keyof typeof labels

async function json<T>(res: Awaited<ReturnType<Api['ctx']['get']>>): Promise<T> {
  expect(res.ok(), `${res.url()}: ${res.status()} ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'page is wider than the viewport').toBeLessThanOrEqual(0)
}

/** A project with a floorplan (Zigbee gateway + bulb) and a board with an enclosure, a power supply, actuators and an overflowing row. */
async function seed(api: Api, lang: Lang) {
  const c = await boardCatalog(api)
  const project = await api.createProject({ name: unique('Board visual'), productTypeIds: [c.knx.id, c.zigbee.id] })
  const version = project.versions[0].id
  const floor = await api.createPlan(version, 'Ground floor', planImage())
  await api.savePlanContent(floor.id, {
    placements: [
      { variantId: c.gateway.variantId, x: 100, y: 100 },
      { variantId: c.bulb.variantId, x: 300, y: 300 },
    ],
  })
  const board = await json<{ id: string }>(await api.ctx.post(`/api/versions/${version}/boards`, { data: { name: labels[lang].boardName, enclosureVariantId: c.enclosure.variantId } }))
  await json(await api.ctx.post(`/api/plans/${board.id}/lock`))
  const content = await json<{ contentUpdatedAt: string; rows: { id: string; capacityTe: number }[] }>(await api.ctx.get(`/api/plans/${board.id}/board`))
  const [r1, r2] = content.rows
  const mod = (variantId: string, rowId: string, offsetTe: number, label = '', existing = false) => ({ id: crypto.randomUUID(), variantId, rowId, offsetTe, label, existing, addonVariantIds: [], instanceValues: {} })
  await json(
    await api.ctx.put(`/api/plans/${board.id}/board`, {
      data: {
        expectedContentUpdatedAt: content.contentUpdatedAt,
        enclosureVariantId: c.enclosure.variantId,
        rows: content.rows.map((r) => ({ id: r.id, capacityTe: r.capacityTe })),
        modules: [
          mod(c.psu.variantId, r1.id, 0, 'PS1'),
          mod(c.actuator.variantId, r1.id, 2, 'Q1'),
          mod(c.actuator.variantId, r1.id, 6, '', true),
          mod(c.actuator.variantId, r2.id, 0),
          mod(c.actuator.variantId, r2.id, 4),
          mod(c.actuator.variantId, r2.id, 9.5, 'Overflow'),
        ],
      },
    }),
  )
  await api.ctx.delete(`/api/plans/${board.id}/lock`)
  return { project, version, board }
}

for (const lang of ['en', 'de'] as const) {
  test(`boards and networks fit the screen: ${lang}`, { tag: '@visual' }, async ({ page, api }) => {
    test.setTimeout(600_000)
    const l = labels[lang]
    const s = await seed(api, lang)
    const editor = `/projects/${s.project.id}/versions/${s.version}/boards/${s.board.id}`
    const tab = (p: Page, name: string) => p.getByRole('tab', { name, exact: true }).click()

    type Step = { name: string; path: () => string; wide?: boolean; editor?: boolean; fullPage?: boolean; act?: (p: Page) => Promise<void> }
    const steps: Step[] = [
      { name: 'plan-cards', path: () => `/projects/${s.project.id}`, fullPage: true },
      {
        name: 'add-board',
        path: () => `/projects/${s.project.id}`,
        act: async (p) => {
          await p.getByRole('button', { name: l.addBoard }).click()
          await expect(p.getByRole('dialog')).toBeVisible()
        },
      },
      { name: 'editor', path: () => editor, editor: true },
      { name: 'editor-board-tab', path: () => editor, editor: true, wide: true, act: (p) => tab(p, l.board) },
      {
        name: 'editor-inspector',
        path: () => editor,
        editor: true,
        wide: true,
        act: async (p) => {
          await p.getByRole('button', { name: /^.*, Q1, / }).click()
          await tab(p, l.inspector)
        },
      },
      { name: 'networks', path: () => `/projects/${s.project.id}?tab=networks`, fullPage: true },
    ]

    await page.addInitScript((lng) => window.localStorage.setItem('i18nextLng', lng), lang)
    for (const viewport of viewports) {
      await page.setViewportSize(viewport.size)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        for (const step of steps) {
          if (step.wide && !viewport.wide) continue
          await page.goto(step.path())
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
          if (step.editor && viewport.wide) await expect(page.getByText(l.saved, { exact: true })).toBeVisible()
          await page.waitForLoadState('networkidle')
          if (step.act) await step.act(page)
          await page.waitForTimeout(300)
          await expectNoHorizontalOverflow(page)
          await page.screenshot({ path: `e2e/screenshots/boards-${step.name}-${viewport.name}-${colorScheme}-${lang}.png`, fullPage: step.fullPage ?? false })
          await page.keyboard.press('Escape')
        }
      }
    }
  })
}
