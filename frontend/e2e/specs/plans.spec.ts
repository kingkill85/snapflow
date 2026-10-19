import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from '@playwright/test'

import { type Api, expect, test, unique } from '../fixtures'

// Step 2b: plans and the floorplan editor, clicked through in a real browser
// (Konva canvas: pointer input at image coordinates mapped to the screen).

const assets = join(import.meta.dirname, '../assets')
const floorplan = { width: 1200, height: 800 }

/** A product type, category and product with a variant image, and a project using the type. */
async function seed(api: Api, productName: string) {
  const kind = await api.createKind({}, { abbreviation: 'ZB', color: '#1f6feb' })
  const product = await api.createProduct({ ...kind.ids, name: { en: productName } })
  const file = await api.uploadFile('blue.png', 'image/png', readFileSync(join(assets, 'blue.png')))
  await api.createVariant(product.id, { name: { en: 'White' }, imageFileId: file.id })
  const project = await api.createProject({ name: unique('Plan project') })
  return { kind, product, project }
}

const planImage = () => ({ name: 'floorplan.png', mimeType: 'image/png', buffer: readFileSync(join(assets, 'floorplan.png')) })

/** Maps image pixels to page coordinates: the editor fits the image into the canvas with 16 px padding (fitViewport). */
async function imageToPage(page: Page) {
  const box = (await page.getByTestId('plan-canvas').boundingBox())!
  const scale = Math.min((box.width - 32) / floorplan.width, (box.height - 32) / floorplan.height)
  const ox = box.x + (box.width - floorplan.width * scale) / 2
  const oy = box.y + (box.height - floorplan.height * scale) / 2
  return { box, scale, at: (x: number, y: number) => ({ x: ox + x * scale, y: oy + y * scale }) }
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 4 })
  await page.mouse.up()
}

const saved = (page: Page) => expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 5000 })

test('plans: draw, place, edit, zones, undo/redo, reload', async ({ page, api }) => {
  const { project } = await seed(api, 'Plan switch')
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(`/projects/${project.id}`)

  // A plan with an image.
  await page.getByRole('button', { name: 'Add plan' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add plan' })
  await dialog.getByLabel('Name').fill('Ground floor')
  await dialog.locator('input[type=file]').setInputFiles(join(assets, 'floorplan.png'))
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('link', { name: 'Ground floor' }).click()
  await expect(page.getByRole('tab', { name: 'Products' })).toBeVisible()
  await saved(page)
  const planId = page.url().split('/plans/')[1]
  const map = await imageToPage(page)

  // Place by click (armed palette product) and by drag and drop.
  await page.getByRole('button', { name: /Plan switch/ }).click()
  const p1 = map.at(300, 200)
  await page.mouse.click(p1.x, p1.y)
  const p2 = map.at(900, 600)
  await page.getByRole('button', { name: /Plan switch/ }).dragTo(page.getByTestId('plan-canvas'), { targetPosition: { x: p2.x - map.box.x, y: p2.y - map.box.y } })
  await saved(page)
  let content = await api.planContent(planId)
  expect(content.placements.length).toBe(2)

  // Move the first one (drag), then resize it (corner handle) and rotate it (handle above).
  await drag(page, map.at(300, 200), map.at(350, 250))
  await saved(page)
  content = await api.planContent(planId)
  const moved = content.placements.find((p) => Math.abs(p.x - 350) < 3 && Math.abs(p.y - 250) < 3)
  expect(moved, JSON.stringify(content.placements)).toBeTruthy()
  const se = map.at(moved!.x + moved!.width / 2, moved!.y + moved!.height / 2)
  await drag(page, se, { x: se.x + 30, y: se.y + 30 })
  await saved(page)
  content = await api.planContent(planId)
  const resized = content.placements.find((p) => p.id === moved!.id)!
  expect(resized.width).toBeGreaterThan(moved!.width)
  const centre = map.at(resized.x, resized.y)
  const top = map.at(resized.x, resized.y - resized.height / 2)
  await drag(page, { x: top.x, y: top.y - 24 }, { x: centre.x + 150, y: centre.y })
  await saved(page)
  await page.getByRole('tab', { name: 'Inspector' }).click()
  await expect(page.getByRole('tabpanel', { name: 'Inspector' }).getByLabel('Rotation')).toHaveValue(/^(8[5-9]|9[0-5])(\.\d)?$/)

  // A rectangle zone around the first product, a polygon zone around the second.
  await page.getByRole('button', { name: 'Draw rectangle zone' }).click()
  await drag(page, map.at(40, 40), map.at(580, 380))
  await page.getByRole('button', { name: 'Draw polygon zone' }).click()
  for (const [x, y] of [
    [620, 420],
    [1160, 420],
    [1160, 770],
    [620, 770],
  ]) {
    const p = map.at(x, y)
    await page.mouse.click(p.x, p.y)
  }
  await page.keyboard.press('Enter')
  await saved(page)
  await page.getByRole('tab', { name: 'Zones' }).click()
  const zones = page.getByRole('tabpanel', { name: 'Zones' })
  await expect(zones.getByRole('listitem').filter({ hasText: 'Zone 1' })).toContainText('1 device')
  await expect(zones.getByRole('listitem').filter({ hasText: 'Zone 2' })).toContainText('1 device')
  content = await api.planContent(planId)
  expect(content.zones.map((z) => z.points.length)).toEqual([4, 4])
  expect(content.placements.every((p) => p.zoneId !== null)).toBe(true)

  // Undo removes the polygon zone, redo brings it back.
  await page.getByRole('tab', { name: 'Zones' }).focus()
  await page.keyboard.press('Control+z')
  await expect(zones.getByRole('listitem').filter({ hasText: 'Zone 2' })).toHaveCount(0)
  await page.keyboard.press('Control+Shift+z')
  await expect(zones.getByRole('listitem').filter({ hasText: 'Zone 2' })).toBeVisible()
  await saved(page)

  // Zone properties in the inspector (click in the list selects).
  await zones.getByRole('button', { name: 'Zone 2', exact: true }).click()
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await inspector.getByLabel('Name').fill('Living room')
  await saved(page)

  // Reload shows the saved content.
  await page.reload()
  await page.getByRole('tab', { name: 'Zones' }).click()
  await expect(page.getByRole('tabpanel', { name: 'Zones' }).getByRole('listitem').filter({ hasText: 'Living room' })).toContainText('1 device')
  content = await api.planContent(planId)
  expect(content.zones.map((z) => z.name)).toEqual(['Zone 1', 'Living room'])
  expect(content.placements).toHaveLength(2)
})

test('plans: calibration, layers and PNG export', async ({ page, api }) => {
  const { project, kind } = await seed(api, 'Layer switch')
  const plan = await api.createPlan(project.versions[0].id, 'Attic', planImage())
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(`/projects/${project.id}/versions/${project.versions[0].id}/plans/${plan.id}`)
  await saved(page)
  const map = await imageToPage(page)
  await page.getByRole('button', { name: /Layer switch/ }).click()
  const p = map.at(600, 200)
  await page.mouse.click(p.x, p.y)

  // Calibrate: two points 600 px apart are 6 m.
  await page.getByRole('button', { name: 'Calibrate scale' }).click()
  const a = map.at(300, 700)
  const b = map.at(900, 700)
  await page.mouse.click(a.x, a.y)
  await page.mouse.click(b.x, b.y)
  const dialog = page.getByRole('dialog', { name: 'Calibrate scale' })
  await dialog.getByLabel('Real distance').fill('6')
  await dialog.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByLabel(/^Scale: the bar is/)).toBeVisible()
  await saved(page)
  expect((await api.planContent(plan.id)).scale).toBeCloseTo(0.01, 4)

  // Layers: hiding the product type leaves nothing to select.
  await page.getByRole('tab', { name: 'Layers' }).click()
  const layers = page.getByRole('tabpanel', { name: 'Layers' })
  const typeSwitch = layers.getByRole('group', { name: 'Product types' }).getByRole('switch', { name: kind.type.name.en })
  await typeSwitch.click()
  await page.mouse.click(p.x, p.y)
  await page.getByRole('tab', { name: 'Inspector' }).click()
  await expect(page.getByRole('tabpanel', { name: 'Inspector' })).toContainText('Select a product or zone')
  await page.getByRole('tab', { name: 'Layers' }).click()
  await typeSwitch.click()

  // Export: a PNG at the image's natural size named after project and plan.
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export PNG' }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe(`${project.number} Attic.png`)
  const bytes = readFileSync((await file.path())!)
  expect(bytes.readUInt32BE(16)).toBe(floorplan.width)
  expect(bytes.readUInt32BE(20)).toBe(floorplan.height)
})

test('plans: the lock, take over, read-only projects', async ({ page, api, sessionFor }) => {
  // The first editor learns of the take-over with its next heartbeat (every 30 s).
  test.setTimeout(90_000)
  const { project } = await seed(api, 'Lock switch')
  const version = project.versions[0].id
  const plan = await api.createPlan(version, 'Cellar', planImage())
  const url = `/projects/${project.id}/versions/${version}/plans/${plan.id}`
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(url)
  await saved(page)

  // A user sees who edits it, and cannot take over.
  const user = await api.createUser({ role: 'user', fullName: unique('Planner') })
  const other = await sessionFor(user)
  await other.setViewportSize({ width: 1400, height: 900 })
  await other.goto(url)
  await expect(other.getByText(/Being edited by .* until/)).toBeVisible()
  await expect(other.getByText('View only')).toBeVisible()
  await expect(other.getByRole('button', { name: 'Take over' })).toHaveCount(0)

  // Another admin may take over; the first editor is told.
  const admin2 = await api.createUser({ role: 'admin', fullName: unique('Admin') })
  const second = await sessionFor(admin2)
  await second.setViewportSize({ width: 1400, height: 900 })
  await second.goto(url)
  await second.getByRole('button', { name: 'Take over' }).click()
  await expect(second.getByText('Saved', { exact: true })).toBeVisible()
  await expect(page.getByText(/has taken over this plan/)).toBeVisible({ timeout: 45_000 })

  // A completed project opens read-only.
  const done = await api.createProject({ name: unique('Done project') })
  const donePlan = await api.createPlan(done.versions[0].id, 'Roof', planImage())
  const current = await api.ctx.get(`/api/projects/${done.id}`).then((r) => r.json())
  const res = await api.ctx.put(`/api/projects/${done.id}`, { data: { name: done.name, status: 'completed', expectedUpdatedAt: current.updatedAt } })
  expect(res.ok(), await res.text()).toBe(true)
  await page.goto(`/projects/${done.id}/versions/${done.versions[0].id}/plans/${donePlan.id}`)
  await expect(page.getByText('This project is completed or cancelled: the plan can only be viewed.')).toBeVisible()
  await expect(page.getByText('View only')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Draw rectangle zone' })).toBeDisabled()
})

test('plans: zone corners are dragged, added and removed', async ({ page, api }) => {
  const { project } = await seed(api, 'Corner switch')
  const plan = await api.createPlan(project.versions[0].id, 'Corners', planImage())
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(`/projects/${project.id}/versions/${project.versions[0].id}/plans/${plan.id}`)
  await saved(page)
  const map = await imageToPage(page)
  const near = (points: number[][], x: number, y: number) => points.some(([px, py]) => Math.abs(px - x) < 4 && Math.abs(py - y) < 4)

  await page.getByRole('button', { name: 'Draw rectangle zone' }).click()
  await drag(page, map.at(100, 100), map.at(500, 400))
  await saved(page)
  // Selected by a click inside: its corners and edge midpoints get handles.
  const inside = map.at(300, 250)
  await page.mouse.click(inside.x, inside.y)
  await page.getByRole('tab', { name: 'Inspector' }).click()
  await expect(page.getByRole('tabpanel', { name: 'Inspector' }).getByText('4 corners')).toBeVisible()

  // Drag the top right corner.
  await drag(page, map.at(500, 100), map.at(560, 60))
  await saved(page)
  let points = (await api.planContent(plan.id)).zones[0].points
  expect(points).toHaveLength(4)
  expect(near(points, 560, 60), JSON.stringify(points)).toBe(true)

  // A click on the top edge's midpoint adds a corner there.
  const mid = map.at(330, 80)
  await page.mouse.click(mid.x, mid.y)
  await saved(page)
  points = (await api.planContent(plan.id)).zones[0].points
  expect(points, JSON.stringify(points)).toHaveLength(5)
  expect(near(points, 330, 80), JSON.stringify(points)).toBe(true)

  // Alt-click removes the bottom left corner.
  const corner = map.at(100, 400)
  await page.keyboard.down('Alt')
  await page.mouse.click(corner.x, corner.y)
  await page.keyboard.up('Alt')
  await saved(page)
  points = (await api.planContent(plan.id)).zones[0].points
  expect(points, JSON.stringify(points)).toHaveLength(4)
  expect(near(points, 100, 400)).toBe(false)
})
