import type { Page } from '@playwright/test'

import { expect, test } from '../fixtures'
import { findingsSeed } from '../findings-seed'

// One problem list (D453, D454) at phone, tablet and desktop width, light and dark, English and German: the
// Checks tab grouped by plan (errors, warnings, infos, the version's networks), the board's Problems tab (row
// overflow, unknown width), the floorplan with an inactive variant (marker) next to unconnected needs (no
// marker) and an add-on finding, the dimmer's inspector with a channel warning. Nothing overflows the
// viewport (D107). Screenshots land in e2e/screenshots/findings-*.png. Tagged @visual.

const viewports = [
  { name: 'phone', size: { width: 390, height: 844 }, wide: false },
  { name: 'tablet', size: { width: 768, height: 1024 }, wide: true },
  { name: 'desktop', size: { width: 1280, height: 800 }, wide: true },
]
const labels = {
  en: { saved: 'Saved', inspector: 'Inspector', problems: /^Problems/ },
  de: { saved: 'Gespeichert', inspector: 'Eigenschaften', problems: /^Probleme/ },
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'page is wider than the viewport').toBeLessThanOrEqual(0)
}

for (const lang of ['en', 'de'] as const) {
  test(`findings fit the screen: ${lang}`, { tag: '@visual' }, async ({ page, api }) => {
    test.setTimeout(600_000)
    const l = labels[lang]
    const s = await findingsSeed(api)
    await s.breakIt()
    const base = `/projects/${s.project.id}/versions/${s.versionId}`
    const problems = (p: Page) => p.getByRole('tab', { name: l.problems }).click()
    const select = (label: string) => async (p: Page) => {
      await p.getByRole('button', { name: new RegExp(`^.*, ${label}, `) }).click()
      await expect(p.getByRole('tab', { name: l.inspector, exact: true })).toHaveAttribute('aria-selected', 'true')
    }
    type Step = { name: string; path: string; editor?: boolean; fullPage?: boolean; act?: (p: Page) => Promise<void> }
    const steps: Step[] = [
      { name: 'checks', path: `${base}?tab=checks`, fullPage: true },
      { name: 'board-problems', path: `${base}/boards/${s.board.id}`, editor: true, act: problems },
      { name: 'board-inspector-channel', path: `${base}/boards/${s.board.id}`, editor: true, act: select('D1') },
      { name: 'floorplan-problems', path: `${base}/plans/${s.floor.id}`, editor: true, act: problems },
    ]
    await page.addInitScript((lng) => window.localStorage.setItem('i18nextLng', lng), lang)
    for (const viewport of viewports) {
      await page.setViewportSize(viewport.size)
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme })
        for (const step of steps) {
          if (step.editor && !viewport.wide) continue
          await page.goto(step.path)
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
          if (step.editor) await expect(page.getByText(l.saved, { exact: true })).toBeVisible()
          await page.waitForLoadState('networkidle')
          if (step.act) await step.act(page)
          await page.waitForTimeout(300)
          await expectNoHorizontalOverflow(page)
          await page.screenshot({ path: `e2e/screenshots/findings-${step.name}-${viewport.name}-${colorScheme}-${lang}.png`, fullPage: step.fullPage ?? false })
          await page.keyboard.press('Escape')
        }
      }
    }
  })
}
