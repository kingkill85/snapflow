import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from '@playwright/test'

import { expect, test, unique, uniqueKey } from '../fixtures'

// Step 3b: zone needs, room templates and load symbols, clicked through.

const assets = join(import.meta.dirname, '../assets')
const floorplan = { width: 1200, height: 800 }
const planImage = () => ({ name: 'floorplan.png', mimeType: 'image/png', buffer: readFileSync(join(assets, 'floorplan.png')) })

/** Image pixels to page coordinates (the editor fits the image with 16 px padding). */
async function imageToPage(page: Page) {
  const box = (await page.getByTestId('plan-canvas').boundingBox())!
  const scale = Math.min((box.width - 32) / floorplan.width, (box.height - 32) / floorplan.height)
  const ox = box.x + (box.width - floorplan.width * scale) / 2
  const oy = box.y + (box.height - floorplan.height * scale) / 2
  return (x: number, y: number) => ({ x: ox + x * scale, y: oy + y * scale })
}

const saved = (page: Page) => expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 5000 })
const rect = (x0: number, y0: number, x1: number, y1: number) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
]

test('needs: room template, apply to a zone, add a need, place a load symbol, overview', async ({ page, api }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await api.createKind()
  const light = unique('Dimmable light')
  const blind = unique('Blind')
  const lightType = await api.createFunctionType(uniqueKey('dimmable_light'), light)
  const blindType = await api.createFunctionType(uniqueKey('blind'), blind)
  const project = await api.createProject({ name: unique('Needs project') })
  const versionId = project.versions[0].id
  const plan = await api.createPlan(versionId, 'Ground floor', planImage())
  const living = { id: crypto.randomUUID(), name: 'Living', color: '#3b82f6', opacity: 0.25, points: rect(100, 100, 500, 500) }
  const kitchen = { id: crypto.randomUUID(), name: 'Kitchen', color: '#22c55e', opacity: 0.25, points: rect(600, 100, 1100, 500) }
  await api.savePlanContent(plan.id, { zones: [living, kitchen], placements: [] })

  // A room template in the catalog.
  const templateName = unique('Living room')
  await page.goto('/catalog/room-templates')
  await page.getByRole('button', { name: 'New room template' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New room template' })
  await dialog.getByLabel('Key').fill(uniqueKey('living'))
  await dialog.getByRole('textbox', { name: 'Name' }).fill(templateName)
  await dialog.getByRole('button', { name: 'Add line' }).click()
  const line = dialog.getByRole('group', { name: 'Line 1' })
  await line.getByRole('combobox', { name: 'Function' }).click()
  await page.getByRole('option', { name: light }).click()
  await line.getByLabel('Quantity').fill('3')
  await line.getByLabel(/Power per unit/).fill('7.5')
  await line.getByLabel('Label').fill('Ceiling')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('cell', { name: templateName, exact: true })).toBeVisible()

  // The editor: apply the template to Living and add a need by hand.
  await page.goto(`/projects/${project.id}/versions/${versionId}/plans/${plan.id}`)
  await saved(page)
  await page.getByRole('tab', { name: 'Zones' }).click()
  await page.getByRole('tabpanel', { name: 'Zones' }).getByRole('button', { name: 'Living', exact: true }).click()
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  const needs = inspector.getByRole('region', { name: 'Needs' })
  await needs.getByRole('combobox', { name: 'Apply template' }).click()
  await page.getByRole('option', { name: templateName }).click()
  await expect(needs.getByRole('listitem', { name: `3 × ${light} · 7.5 W · Ceiling` })).toBeVisible()
  await needs.getByRole('combobox', { name: 'Add need' }).click()
  await page.getByRole('option', { name: blind }).click()
  await needs.getByLabel('Label').fill('Window')
  await needs.getByRole('button', { name: 'Done' }).click()
  await expect(needs.getByRole('listitem', { name: `1 × ${blind} · Window` })).toBeVisible()
  await saved(page)

  // A load symbol in the kitchen.
  await page.getByRole('button', { name: 'Place need' }).click()
  await page.getByRole('combobox', { name: 'Function of the next symbol' }).click()
  await page.getByRole('option', { name: light }).click()
  const at = await imageToPage(page)
  const spot = at(850, 300)
  await page.mouse.click(spot.x, spot.y)
  await expect(inspector.getByText('Need symbol')).toBeVisible()
  await expect(inspector.getByText('Zone: Kitchen')).toBeVisible()
  await saved(page)

  const content = await api.planContent(plan.id)
  expect(content.needs).toHaveLength(3)
  const symbol = content.needs.find((n) => n.x !== null)!
  expect(symbol).toMatchObject({ functionTypeId: lightType.id, zoneId: kitchen.id })
  expect(content.needs.filter((n) => n.zoneId === living.id).map((n) => [n.functionTypeId, n.quantity, n.powerW, n.label])).toEqual([
    [lightType.id, 3, '7.50', 'Ceiling'],
    [blindType.id, 1, null, 'Window'],
  ])

  // Reload shows everything: counts per zone in the Zones tab.
  await page.reload()
  await saved(page)
  await page.getByRole('tab', { name: 'Zones' }).click()
  await expect(page.getByTestId(`zone-needs-${living.id}`)).toHaveText('4 needs')
  await expect(page.getByTestId(`zone-needs-${kitchen.id}`)).toHaveText('1 need')

  // The version's needs overview lists them with totals.
  await page.goto(`/projects/${project.id}?tab=needs`)
  await expect(page.getByRole('heading', { name: 'Needs by room' })).toBeVisible()
  const planRegion = page.getByRole('region', { name: 'Ground floor' })
  await expect(planRegion.getByRole('list', { name: 'Living' })).toContainText(`3 × ${light} · 7.5 W · Ceiling`)
  await expect(planRegion.getByRole('list', { name: 'Kitchen' })).toContainText('Symbol on plan')
  await expect(page.getByText('All plans: 5 units · 22.5 W')).toBeVisible()
  const byFunction = page.getByRole('table', { name: 'Totals by function' })
  await expect(byFunction.getByRole('row', { name: new RegExp(light) })).toContainText('4')
})
