import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Locator, Page } from '@playwright/test'

import { boardCatalog } from '../boards-catalog'
import { expect, test, unique } from '../fixtures'

// Step 3c: a board with an enclosure, modules dragged from the palette, TE
// totals, the BOM lines, and the Networks tab (bus lines, Zigbee gateways).

const assets = join(import.meta.dirname, '../assets')
const planImage = () => ({ name: 'floorplan.png', mimeType: 'image/png', buffer: readFileSync(join(assets, 'floorplan.png')) })

const rail = (page: Page, n: number) => page.getByRole('group', { name: new RegExp(`^Row ${n}:`) })

async function dragTo(page: Page, product: string, target: Locator, x: number) {
  await page.getByRole('tab', { name: 'Products' }).click()
  await page.getByRole('complementary').getByRole('button', { name: new RegExp(product) }).dragTo(target, { targetPosition: { x, y: 40 } })
}

test('boards: enclosure, modules, totals, BOM, networks', async ({ page, api }) => {
  const c = await boardCatalog(api)
  const project = await api.createProject({ name: unique('Board project'), productTypeIds: [c.knx.id, c.zigbee.id] })
  const versionId = project.versions[0].id
  // A floorplan with two Zigbee gateways and a bulb (default: the first gateway).
  const floor = await api.createPlan(versionId, 'Ground floor', planImage())
  await api.savePlanContent(floor.id, {
    placements: [
      { variantId: c.gateway.variantId, x: 100, y: 100 },
      { variantId: c.gateway.variantId, x: 600, y: 100 },
      { variantId: c.bulb.variantId, x: 300, y: 300 },
    ],
  })

  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(`/projects/${project.id}`)
  await page.getByRole('button', { name: 'Add board' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add board' })
  await dialog.getByLabel('Name').fill('Main board')
  await dialog.getByRole('combobox', { name: 'Enclosure' }).click()
  await page.getByRole('option', { name: new RegExp(c.enclosure.name) }).click()
  await expect(dialog.getByText('2 rows × 12 TE')).toBeVisible()
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByText('0 modules · 0 of 24 TE')).toBeVisible()

  await page.getByRole('link', { name: /Main board/ }).click()
  await expect(page.getByRole('heading', { name: 'Main board' })).toBeVisible()
  await expect(page.getByText('Saved')).toBeVisible()

  // Power supply at the start of row 1, two actuators after it (the second lands in the next free gap).
  await dragTo(page, c.psu.name, rail(page, 1), 5)
  await expect(page.getByRole('button', { name: new RegExp(`^${c.psu.name}, 2 TE`) })).toBeVisible()
  await dragTo(page, c.actuator.name, rail(page, 1), 5)
  await dragTo(page, c.actuator.name, rail(page, 1), 5)
  await expect(page.getByRole('button', { name: new RegExp(`^${c.actuator.name}, 4 TE`) })).toHaveCount(2)
  await expect(page.getByTestId('board-totals')).toHaveText('3 modules · 10 / 24 TE')
  await expect(page.getByText('10 / 12 TE')).toBeVisible()

  // Keyboard: the second actuator moves down to row 2.
  const second = page.getByRole('button', { name: new RegExp(`^${c.actuator.name}, 4 TE`) }).nth(1)
  await second.focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByText('6 / 12 TE')).toBeVisible()
  await expect(page.getByText('4 / 12 TE')).toBeVisible()

  // Undo and redo the move.
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByText('10 / 12 TE')).toBeVisible()
  await page.getByRole('button', { name: 'Redo' }).click()
  await expect(page.getByText('4 / 12 TE')).toBeVisible()
  await expect(page.getByText('Saved')).toBeVisible()

  // Reload keeps it.
  await page.reload()
  await expect(page.getByTestId('board-totals')).toHaveText('3 modules · 10 / 24 TE')
  await expect(page.getByText('4 / 12 TE')).toBeVisible()

  // The BOM: modules and the enclosure.
  await page.getByRole('link', { name: new RegExp(project.name) }).click()
  await expect(page.getByText('3 modules · 10 of 24 TE')).toBeVisible()
  await page.getByRole('tab', { name: 'Bill of materials' }).click()
  const bom = page.getByRole('table', { name: 'Bill of materials' })
  await expect(bom.getByRole('row').filter({ hasText: c.actuator.name }).getByRole('cell').nth(-3)).toHaveText('2')
  await expect(bom.getByRole('row').filter({ hasText: c.psu.name }).getByRole('cell').nth(-3)).toHaveText('1')
  await expect(bom.getByRole('row').filter({ hasText: c.enclosure.name }).getByRole('cell').nth(-3)).toHaveText('1')

  // Checks: the automatic line's power supply carries the two actuators (D451, D452).
  await page.getByRole('tab', { name: 'Checks' }).click()
  await expect(page.getByText('Bus line Line 1')).toBeVisible()
  await expect(page.getByText('20 of 640 mA (reserve', { exact: false })).toBeVisible()
  await expect(page.getByText(/^3 devices/)).toBeVisible()

  // Networks: "Line 1" was created with the first save and holds every KNX module by default.
  await page.getByRole('tab', { name: 'Networks' }).click()
  await expect(page).toHaveURL(/\?tab=networks/)
  const knx = page.getByRole('region', { name: /KNX/ })
  const first = knx.getByRole('table', { name: 'Line 1' })
  await expect(first.getByRole('row').filter({ hasText: c.actuator.name })).toHaveCount(2)
  await expect(first.getByRole('row').filter({ hasText: c.psu.name })).toHaveCount(1)
  await expect(knx.getByRole('button', { name: 'Delete Line 1' })).toBeDisabled()

  // A second KNX line, an actuator moved to it.
  await knx.getByRole('button', { name: 'Add line' }).click()
  const line = page.getByRole('dialog', { name: 'New line' })
  await line.getByLabel('Name').fill('KNX 2')
  await line.getByLabel('Address').fill('1.2')
  await line.getByRole('button', { name: 'Create' }).click()
  await expect(line).toBeHidden()
  await knx.getByRole('combobox', { name: new RegExp(`^Line of ${c.actuator.name}`) }).first().click()
  await page.getByRole('option', { name: 'KNX 2' }).click()
  const second2 = knx.getByRole('table', { name: 'KNX 2' })
  await expect(second2.getByRole('row').filter({ hasText: c.actuator.name })).toHaveCount(1)
  await expect(second2.getByText('Pinned')).toBeVisible()

  // Zigbee: the bulb moves to the second gateway.
  const zb = page.getByRole('region', { name: /Zigbee/ })
  const bulbSelect = zb.getByRole('combobox', { name: new RegExp(`^Gateway of ${c.bulb.name}`) })
  const before = await bulbSelect.textContent()
  await bulbSelect.click()
  const options = page.getByRole('option')
  await expect(options).toHaveCount(2)
  await options.filter({ hasNotText: before ?? '' }).first().click()
  await expect(zb.getByText('Pinned')).toBeVisible()

  // Reload keeps the assignments.
  await page.reload()
  await expect(page.getByRole('region', { name: /KNX/ }).getByRole('table', { name: 'KNX 2' }).getByRole('row').filter({ hasText: c.actuator.name })).toHaveCount(1)
  await expect(page.getByRole('region', { name: /Zigbee/ }).getByText('Pinned')).toBeVisible()
  await expect(page.getByRole('region', { name: /Zigbee/ }).getByRole('combobox', { name: new RegExp(`^Gateway of ${c.bulb.name}`) })).not.toHaveText(before ?? '')
})
