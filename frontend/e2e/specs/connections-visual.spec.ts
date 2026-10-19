import type { Page } from '@playwright/test'

import { type Api, expect, test } from '../fixtures'
import { wiringSeed } from '../wiring-seed'

// The Checks tab, the connect picker, the auto-connect dialog, the board
// inspector's channel list, the floorplan zone statuses and the Networks
// statuses (step 3d) at phone, tablet and desktop width, light and dark,
// English and German: nothing overflows the viewport (D107). Screenshots
// land in e2e/screenshots/connections-*.png. Tagged @visual.

const viewports = [
  { name: 'phone', size: { width: 390, height: 844 }, wide: false },
  { name: 'tablet', size: { width: 768, height: 1024 }, wide: true },
  { name: 'desktop', size: { width: 1280, height: 800 }, wide: true },
]

const labels = {
  en: { checks: 'Checks', auto: 'Auto-connect…', preview: 'Preview', connect: 'Connect…', inspector: 'Inspector', zones: 'Zones', saved: 'Saved' },
  de: { checks: 'Prüfungen', auto: 'Automatisch verbinden…', preview: 'Vorschau', connect: 'Verbinden…', inspector: 'Eigenschaften', zones: 'Zonen', saved: 'Gespeichert' },
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'page is wider than the viewport').toBeLessThanOrEqual(0)
}

/** Auto-connects the whole version through the API (as the dialog does). */
async function autoConnect(api: Api, versionId: string) {
  const preview = await api.ctx.post(`/api/versions/${versionId}/auto-connect/preview`, { data: { scope: 'all' } })
  expect(preview.ok(), await preview.text()).toBe(true)
  const { checksum } = (await preview.json()) as { checksum: string }
  const apply = await api.ctx.post(`/api/versions/${versionId}/auto-connect/apply`, { data: { scope: 'all', expectedChecksum: checksum } })
  expect(apply.ok(), await apply.text()).toBe(true)
}

for (const lang of ['en', 'de'] as const) {
  test(`connections and checks fit the screen: ${lang}`, { tag: '@visual' }, async ({ page, api }) => {
    test.setTimeout(600_000)
    const l = labels[lang]
    // Two projects: one with nothing connected, one auto-connected with the dimmer's bus current near the limit.
    const open = await wiringSeed(api)
    const done = await wiringSeed(api)
    await autoConnect(api, done.versionId)
    const dimmer = (await (await api.ctx.get(`/api/products/${done.dimmer.id}`)).json()) as { attributes: Record<string, unknown> }
    await api.updateProduct(done.dimmer.id, { attributes: { ...dimmer.attributes, [done.f.busMa.key]: 80 } })

    const checks = (s: typeof open) => `/projects/${s.project.id}/versions/${s.versionId}?tab=checks`
    const board = `/projects/${done.project.id}/versions/${done.versionId}/boards/${done.board.id}`
    const floor = `/projects/${done.project.id}/versions/${done.versionId}/plans/${done.floor.id}`
    const selectModule = async (p: Page, label: string) => {
      await p.getByRole('button', { name: new RegExp(`^.*, ${label}, `) }).click()
      await expect(p.getByRole('tab', { name: l.inspector, exact: true })).toHaveAttribute('aria-selected', 'true')
    }

    type Step = { name: string; path: () => string; wide?: boolean; editor?: boolean; fullPage?: boolean; act?: (p: Page) => Promise<void> }
    const steps: Step[] = [
      { name: 'checks-missing', path: () => checks(open), fullPage: true },
      {
        name: 'auto-connect-preview',
        path: () => checks(open),
        act: async (p) => {
          await p.getByRole('button', { name: l.auto }).click()
          const dialog = p.getByRole('dialog')
          await dialog.getByRole('button', { name: l.preview }).click()
          await expect(dialog.getByRole('status')).toBeVisible()
        },
      },
      {
        name: 'connect-picker',
        path: () => checks(open),
        act: async (p) => {
          await p.getByRole('button', { name: new RegExp(`· Spots`) }).first().click()
          await expect(p.getByRole('dialog').getByRole('list')).toBeVisible()
        },
      },
      { name: 'checks-connected', path: () => checks(done), fullPage: true },
      { name: 'board-channels', path: () => board, editor: true, wide: true, act: (p) => selectModule(p, 'J1') },
      { name: 'board-relay-alternatives', path: () => board, editor: true, wide: true, act: (p) => selectModule(p, 'Q1') },
      {
        name: 'floorplan-zone-needs',
        path: () => floor,
        editor: true,
        wide: true,
        act: async (p) => {
          await p.getByRole('tab', { name: l.zones, exact: true }).click()
          await p.getByRole('tabpanel', { name: l.zones }).getByRole('button', { name: 'Kitchen', exact: true }).click()
        },
      },
      { name: 'networks', path: () => `/projects/${done.project.id}?tab=networks`, fullPage: true },
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
          if (step.editor) await expect(page.getByText(l.saved, { exact: true })).toBeVisible()
          await page.waitForLoadState('networkidle')
          if (step.act) await step.act(page)
          await page.waitForTimeout(300)
          await expectNoHorizontalOverflow(page)
          await page.screenshot({ path: `e2e/screenshots/connections-${step.name}-${viewport.name}-${colorScheme}-${lang}.png`, fullPage: step.fullPage ?? false })
          await page.keyboard.press('Escape')
        }
      }
    }
  })
}
