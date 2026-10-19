import type { Page } from '@playwright/test'

import { expect, test } from '../fixtures'
import { autoConnect, catalog, complete, json, villa } from '../villa-seed'

// The Checks tab, the auto-connect dialog, the connect picker (need and
// channel mode), the board inspector's channel list, the floorplan zone
// statuses, the Networks statuses and a read-only project (step 3d) at phone,
// tablet and desktop width, light and dark, English and German: nothing
// overflows the viewport (D107). Seed: an HDL Buspro villa in Lahore with one
// KNX line and Zigbee (D417). Screenshots land in
// e2e/screenshots/connections-*.png. Tagged @visual.

const viewports = [
  { name: 'phone', size: { width: 390, height: 844 }, wide: false },
  { name: 'tablet', size: { width: 768, height: 1024 }, wide: true },
  { name: 'desktop', size: { width: 1280, height: 800 }, wide: true },
]

const labels = {
  en: {
    auto: 'Auto-connect…',
    preview: 'Preview',
    apply: 'Apply',
    undo: 'Undo auto-connect',
    inspector: 'Inspector',
    zones: 'Zones',
    saved: 'Saved',
    connectChannel: /^Connect a need to /,
  },
  de: {
    auto: 'Automatisch verbinden…',
    preview: 'Vorschau',
    apply: 'Übernehmen',
    undo: 'Automatisches Verbinden rückgängig',
    inspector: 'Eigenschaften',
    zones: 'Zonen',
    saved: 'Gespeichert',
    connectChannel: /^Bedarf mit .* verbinden$/,
  },
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'page is wider than the viewport').toBeLessThanOrEqual(0)
}

for (const lang of ['en', 'de'] as const) {
  test(`connections and checks fit the screen: ${lang}`, { tag: '@visual' }, async ({ page, api }) => {
    test.setTimeout(900_000)
    const l = labels[lang]
    const cat = await catalog(api, lang)
    const villaName = lang === 'en' ? 'Villa Gulberg, Lahore' : 'Villa Gulberg, Lahore'
    // Three villas: nothing connected; auto-connected and then changed; completed (read-only).
    const open = await villa(api, cat, lang, villaName)
    const done = await villa(api, cat, lang, villaName)
    const readOnly = await villa(api, cat, lang, villaName)
    await autoConnect(api, done.version)
    await autoConnect(api, readOnly.version)
    await complete(api, readOnly.project.id, readOnly.project.name)

    // After the auto-connect: the chandelier gets a bigger lamp (mixed LED + halogen circuit over the limit, D408) and
    // the first floor's second gateway is removed while a door sensor is pinned to it (dangling, D411).
    const [ground, first] = done.plans
    const placements = first.content.placements as { id: string; variantId: string; x: number; y: number }[]
    const gateways = placements.filter((p) => p.variantId === cat.products.gateway.variantId)
    const sensor = placements.find((p) => p.variantId === cat.products.sensor.variantId)!
    await json(
      await api.ctx.put(`/api/versions/${done.version}/network-assignments`, {
        data: { assignments: [{ planId: first.id, itemId: sensor.id, gatewayPlanId: first.id, gatewayItemId: gateways[1].id }] },
      }),
    )
    await api.savePlanContent(first.id, { ...first.content, placements: placements.filter((p) => p.id !== gateways[1].id) })
    await api.savePlanContent(ground.id, {
      ...ground.content,
      needs: ground.content.needs!.map((n) => (n.label === (lang === 'en' ? 'Chandelier' : 'Kronleuchter') ? { ...n, powerW: '200' } : n)),
    })

    const checks = (s: typeof open) => `/projects/${s.project.id}/versions/${s.version}?tab=checks`
    const board = (s: typeof open) => `/projects/${s.project.id}/versions/${s.version}/boards/${s.board.id}`
    const floor = (s: typeof open) => `/projects/${s.project.id}/versions/${s.version}/plans/${s.plans[0].id}`
    const selectModule = async (p: Page, label: string) => {
      await p.getByRole('button', { name: new RegExp(`^.*, ${label}, `) }).click()
      await expect(p.getByRole('tab', { name: l.inspector, exact: true })).toHaveAttribute('aria-selected', 'true')
    }
    const selectZone = async (p: Page, name: string) => {
      await p.getByRole('tab', { name: l.zones, exact: true }).click()
      await p.getByRole('tabpanel', { name: l.zones }).getByRole('button', { name, exact: true }).click()
    }
    const preview = async (p: Page) => {
      await p.getByRole('button', { name: l.auto }).click()
      const dialog = p.getByRole('dialog')
      await dialog.getByRole('button', { name: l.preview }).click()
      await expect(dialog.getByRole('status')).toBeVisible()
    }
    const unconnected = (needLabel: string) => async (p: Page) => {
      await p.getByRole('button', { name: new RegExp(`· ${needLabel}`) }).first().click()
      await expect(p.getByRole('dialog')).toBeVisible()
      await p.waitForLoadState('networkidle')
    }
    const de = lang === 'de'

    type Step = { name: string; path: () => string; wide?: boolean; editor?: boolean; readOnly?: boolean; fullPage?: boolean; act?: (p: Page) => Promise<void>; after?: (p: Page) => Promise<void> }
    const steps: Step[] = [
      { name: 'checks-missing', path: () => checks(open), fullPage: true },
      { name: 'auto-connect-preview', path: () => checks(open), act: preview },
      {
        name: 'checks-applied',
        path: () => checks(open),
        fullPage: true,
        act: async (p) => {
          await preview(p)
          await p.getByRole('dialog').getByRole('button', { name: l.apply }).click()
          await expect(p.getByRole('button', { name: l.undo })).toBeVisible()
          await p.waitForLoadState('networkidle')
        },
        after: async (p) => {
          await p.getByRole('button', { name: l.undo }).click()
          await expect(p.getByRole('button', { name: l.undo })).toBeHidden()
        },
      },
      { name: 'connect-picker-need', path: () => checks(open), act: unconnected(de ? 'Downlights' : 'Downlights') },
      { name: 'connect-picker-nothing-fits', path: () => checks(open), act: unconnected(de ? 'Warmwasserbereiter' : 'Water heater') },
      { name: 'checks-findings', path: () => checks(done), fullPage: true },
      { name: 'board-dimmer', path: () => board(done), editor: true, wide: true, act: (p) => selectModule(p, 'D1') },
      { name: 'board-relay-pairs', path: () => board(done), editor: true, wide: true, act: (p) => selectModule(p, 'Q1') },
      {
        name: 'connect-picker-channel',
        path: () => board(open),
        editor: true,
        wide: true,
        act: async (p) => {
          await selectModule(p, 'C1')
          await p.getByRole('region', { name: de ? 'Kanäle' : 'Channels' }).getByRole('button', { name: l.connectChannel }).first().click()
          await expect(p.getByRole('dialog')).toBeVisible()
          await p.waitForLoadState('networkidle')
        },
      },
      { name: 'floorplan-zones', path: () => floor(done), editor: true, wide: true, act: (p) => p.getByRole('tab', { name: l.zones, exact: true }).click() },
      { name: 'floorplan-zone-needs', path: () => floor(done), editor: true, wide: true, act: (p) => selectZone(p, cat.names.drawing[lang]) },
      { name: 'networks', path: () => `/projects/${done.project.id}?tab=networks`, fullPage: true },
      { name: 'readonly-checks', path: () => checks(readOnly), fullPage: true, readOnly: true },
      { name: 'readonly-board', path: () => board(readOnly), editor: true, wide: true, readOnly: true, act: (p) => selectModule(p, 'Q1') },
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
          if (step.editor && !step.readOnly) await expect(page.getByText(l.saved, { exact: true })).toBeVisible()
          await page.waitForLoadState('networkidle')
          if (step.act) await step.act(page)
          await page.waitForTimeout(300)
          await expectNoHorizontalOverflow(page)
          await page.screenshot({ path: `e2e/screenshots/connections-${step.name}-${viewport.name}-${colorScheme}-${lang}.png`, fullPage: step.fullPage ?? false })
          await page.keyboard.press('Escape')
          if (step.after) await step.after(page)
        }
      }
    }
  })
}
