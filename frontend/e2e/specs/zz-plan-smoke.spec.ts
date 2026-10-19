import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from '../fixtures'

const shots = '/tmp/claude-1000/-home-michael-Projects-github-kingkill85-snapflow/863b6447-03c3-4926-85b4-aa381934826b/scratchpad/shots'

test('smoke: plan list and editor', async ({ page, api }) => {
  const kind = await api.createKind({}, { abbreviation: 'ZB', color: '#1f6feb' })
  const product = await api.createProduct({ ...kind.ids, name: { en: 'Smoke switch' } })
  const file = await api.uploadFile('blue.png', 'image/png', readFileSync(join(import.meta.dirname, '../assets/blue.png')))
  await api.createVariant(product.id, { name: { en: 'White' }, imageFileId: file.id })
  const project = await api.createProject({ name: 'Smoke project' })
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto(`/projects/${project.id}`)
  await expect(page.getByText('No plans yet.')).toBeVisible()
  await page.getByRole('button', { name: 'Add plan' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add plan' })
  await dialog.getByLabel('Name').fill('Ground floor')
  await dialog.locator('input[type=file]').setInputFiles(join(import.meta.dirname, '../assets/red.png'))
  await page.screenshot({ path: `${shots}/1-dialog.png` })
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('link', { name: 'Ground floor' })).toBeVisible()
  await page.screenshot({ path: `${shots}/2-list.png`, fullPage: true })
  await page.getByRole('link', { name: 'Ground floor' }).click()
  await expect(page.getByRole('tab', { name: 'Products' })).toBeVisible()
  await expect(page.getByText('Saved')).toBeVisible()
  await page.getByRole('button', { name: /Smoke switch/ }).click()
  const canvas = page.getByTestId('plan-canvas')
  const box = (await canvas.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.getByRole('tab', { name: 'Inspector' })).toBeVisible()
  await expect(page.getByText('Saved')).toBeVisible({ timeout: 5000 })
  await page.getByRole('tab', { name: 'Inspector' }).click()
  await page.screenshot({ path: `${shots}/3-editor.png` })
  await page.keyboard.press('Control+d')
  await expect(page.getByText('Saved')).toBeVisible({ timeout: 5000 })
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(1500)
  await expect(page.getByText('Saved')).toBeVisible({ timeout: 5000 })
  await page.mouse.wheel(0, -300)
  await page.screenshot({ path: `${shots}/4-zoomed.png` })
  await page.reload()
  await expect(page.getByText('Saved')).toBeVisible()
  await page.screenshot({ path: `${shots}/5-reloaded.png` })
})
