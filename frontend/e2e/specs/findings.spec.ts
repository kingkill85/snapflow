import { expect, test } from '../fixtures'
import { findingsSeed } from '../findings-seed'

// One problem list (D453, D454): a catalog change shows up as a finding on the floorplan (marker and Problems
// tab, "Show" selects the item) and in the Checks tab under the plan with a link back into the editor; two
// overlapping modules are an error in the board's Problems tab and the Checks tab until one is removed.
test('findings: inactive variant and overlapping modules in the editors and the Checks tab', async ({ page, api }) => {
  const s = await findingsSeed(api)
  const base = `/projects/${s.project.id}/versions/${s.versionId}`
  const inactive = /: the variant is inactive in the catalog\.$/
  const overlap = /: the module overlaps another one/
  await page.setViewportSize({ width: 1400, height: 900 })

  // The sensor's variant goes inactive in the catalog.
  await s.setVariantActive(s.sensor.id, false)
  await page.goto(`${base}/plans/${s.floor.id}`)
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: /^Problems \(\d+\)$/ }).click()
  const problems = page.getByRole('tabpanel', { name: /^Problems/ })
  await expect(problems.getByText(inactive)).toBeVisible()
  await problems.getByRole('button', { name: /^Show: .*the variant is inactive/ }).click()
  const inspector = page.getByRole('tabpanel', { name: 'Inspector' })
  await expect(inspector.getByText(inactive)).toBeVisible()
  await expect(inspector).toContainText(s.sensor.name)

  // The Checks tab: under the floorplan, with a link that opens the editor on the sensor.
  await page.goto(`${base}?tab=checks`)
  const findings = page.getByRole('region', { name: 'Findings' })
  const floorGroup = findings.getByRole('region', { name: 'Ground floor' })
  await expect(floorGroup.getByText(inactive)).toBeVisible()
  await floorGroup.getByRole('link', { name: /^Open: .*the variant is inactive/ }).click()
  await expect(page).toHaveURL(new RegExp(`/plans/${s.floor.id}`))
  await expect(page.getByRole('tabpanel', { name: 'Inspector' }).getByText(inactive)).toBeVisible()

  // The dimmer grows to 6 TE in the catalog: D1 now overlaps Q1, an error in both lists.
  await api.updateProduct(s.dimmer.id, { attributes: { ...s.dimmer.attrs, [s.f.width.key]: 6 } })
  await page.goto(`${base}?tab=checks`)
  const boardGroup = findings.getByRole('region', { name: 'Main board' })
  await expect(boardGroup.getByText(overlap).first()).toBeVisible()
  await expect(boardGroup.getByText(overlap).first()).toHaveClass(/text-danger/)
  await page.goto(`${base}/boards/${s.board.id}`)
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: /^Problems \(\d+\)$/ }).click()
  await expect(page.getByRole('tabpanel', { name: /^Problems/ }).getByText(overlap).first()).toBeVisible()

  // Removing D1 fixes it: gone from the Problems tab after the save, and from the Checks tab.
  await page.getByRole('button', { name: /^.*, D1, / }).focus()
  await page.keyboard.press('Delete')
  await expect(page.getByRole('button', { name: /^.*, D1, / })).toHaveCount(0)
  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: /^Problems/ }).click()
  await expect(page.getByRole('tabpanel', { name: /^Problems/ }).getByText(overlap)).toHaveCount(0)
  await page.goto(`${base}?tab=checks`)
  await expect(findings.getByRole('region', { name: 'Ground floor' }).getByText(inactive)).toBeVisible()
  await expect(findings.getByText(overlap)).toHaveCount(0)
})
