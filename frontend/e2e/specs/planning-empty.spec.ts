import { type Page } from '@playwright/test'

import { chooseOption, expect, test, unique, uniqueKey } from '../fixtures'

// Step 4b-1 click-through: a new project's empty states name the next step (D448),
// the Documents tab split by audience (D450), and a product created with its
// first variant (D449) that turns into the variant list with a second one.

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true })

test('a new project: every empty state offers its next step', async ({ page, api }) => {
  const system = await api.createProductType({ name: { en: unique('Empty system') } })
  await api.moveProductTypesToTop([system.id])
  const name = unique('Neubau')
  await page.goto('/projects')
  await page.getByRole('button', { name: 'New project' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Name' }).first().fill(name)
  // Only the new system, which has no products yet (other specs fill the catalog).
  const systems = dialog.getByRole('group', { name: /^Systems/ })
  await expect(systems.getByLabel(system.name.en)).toBeChecked()
  while ((await systems.getByRole('checkbox', { checked: true }).count()) > 0) await systems.getByRole('checkbox', { checked: true }).first().uncheck()
  await systems.getByLabel(system.name.en).check()
  await dialog.getByRole('button', { name: 'Create' }).click()

  // Its first version opens on the Plans tab with the add buttons in the empty state.
  await expect(page.getByRole('heading', { level: 1 })).toContainText(name)
  await expect(page.getByLabel('Version', { exact: true })).toHaveText('V1')
  const empty = page.getByText('Start with a floorplan (an image of the building) or a distribution board.')
  await expect(empty).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add plan' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Add board' })).toHaveCount(1)
  const projectUrl = page.url()

  // Networks and Checks: nothing there yet, each with a link back to the plans.
  await tab(page, 'Networks').click()
  await expect(page.getByText(/Place products of a bus or wireless system on a floorplan or board; they appear here\./)).toBeVisible()
  await page.getByRole('link', { name: 'Go to the plans' }).click()
  await expect(tab(page, 'Plans')).toHaveAttribute('aria-selected', 'true')
  await expect(empty).toBeVisible()
  await tab(page, 'Checks').click()
  await expect(page.getByText('Nothing to check yet. Add needs to the rooms of a floorplan and devices to a board.')).toBeVisible()
  await page.getByRole('link', { name: 'Go to the plans' }).click()
  await expect(tab(page, 'Plans')).toHaveAttribute('aria-selected', 'true')

  // Documents: customer first, then installer.
  await tab(page, 'Documents').click()
  const customer = page.getByRole('heading', { name: 'For the customer' })
  const installer = page.getByRole('heading', { name: 'For the installer' })
  await expect(customer).toBeVisible()
  await expect(installer).toBeVisible()
  await expect(page.getByText('Proposals with prices for this version.')).toBeVisible()
  await expect(page.getByText('Manual, channel labels and programming data for the site.')).toBeVisible()
  expect((await customer.boundingBox())!.y).toBeLessThan((await installer.boundingBox())!.y)

  // A board: the palette has no products of the project's system and links to the catalog.
  await tab(page, 'Plans').click()
  await page.getByRole('button', { name: 'Add board' }).click()
  const board = page.getByRole('dialog', { name: 'Add board' })
  await board.getByLabel('Name').fill('Main board')
  await board.getByRole('button', { name: 'Create' }).click()
  await expect(board).toBeHidden()
  await expect(empty).toHaveCount(0)
  await page.getByRole('link', { name: /Main board/ }).click()
  await expect(page.getByRole('heading', { name: 'Main board' })).toBeVisible()
  await tab(page, 'Products').click()
  await expect(page.getByText("No products of the project's systems go on a board.")).toBeVisible()
  await page.getByRole('link', { name: 'Open the catalog' }).click()
  await expect(page).toHaveURL(/\/catalog/)
  await page.goto(projectUrl)
  await expect(page.getByRole('link', { name: /Main board/ })).toBeVisible()
})

test('a new product with price, SKU and a required variant attribute; one variant, then the list and back', async ({ page, api }) => {
  const { type, category } = await api.createKind({
    name: { en: unique('Switch actuators') },
    attributes: [{ key: 'finish', label: { en: 'Finish' }, type: 'text', scope: 'variant', required: true }],
  })
  const model = uniqueKey('SA')
  const sku = uniqueKey('SKU')
  await page.goto('/catalog/products/new')
  await expect(page.getByRole('heading', { name: 'New product', level: 1 })).toBeVisible()
  await chooseOption(page.getByRole('combobox', { name: 'System' }), type.name.en)
  await chooseOption(page.getByRole('combobox', { name: 'Category' }), category.name.en)
  await page.getByLabel('Model number').fill(model)
  await page.getByRole('textbox', { name: 'Name' }).first().fill('Switch actuator 4-fold')
  await page.getByLabel('Price').fill('120')
  await page.getByLabel('SKU').fill(sku)
  const variantSection = page.getByRole('region', { name: 'Variant', exact: true })
  // The required variant value is refused when empty.
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(variantSection.getByLabel('Finish')).toHaveAttribute('aria-invalid', 'true')
  await variantSection.getByLabel('Finish').fill('White')
  await page.getByRole('button', { name: 'Create' }).click()

  await expect(page.getByText('Product created with its first variant.')).toBeVisible()
  const single = page.getByRole('region', { name: 'Price and variant', exact: true })
  await expect(single.getByLabel('Price')).toHaveValue('120.00')
  await expect(single.getByLabel('SKU')).toHaveValue(sku)
  await expect(single.getByLabel('Finish')).toHaveValue('White')
  const id = page.url().split('/').pop()!

  await single.getByLabel('Price').fill('135')
  await single.getByRole('button', { name: 'Update' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()
  expect((await api.product(id)).variants[0].price).toBe('135.00')

  await single.getByRole('link', { name: 'Add variant' }).click()
  await expect(page.getByRole('heading', { name: 'New variant', level: 1 })).toBeVisible()
  await page.getByRole('textbox', { name: 'Name' }).first().fill('Black')
  await page.getByLabel('Price').fill('140')
  await page.getByLabel('Finish').fill('Black')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByText('Variant created. You can now add its add-ons.')).toBeVisible()
  await page.getByRole('link', { name: 'Back to product' }).click()
  const list = page.getByRole('region', { name: 'Variants', exact: true })
  await expect(single).toHaveCount(0)
  await expect(list.locator('tbody tr')).toHaveCount(2)

  await list.locator('tbody tr').filter({ hasText: 'Black' }).getByRole('button', { name: 'Delete' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete variant' })
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect(confirm).toBeHidden()
  await expect(list).toHaveCount(0)
  await expect(single.getByLabel('Price')).toHaveValue('135.00')
})
