import { expect, navigate, row, test, unique } from '../fixtures'

// Projects and versions (step 2a), as an admin.
test.beforeEach(async ({ api }) => {
  // A project needs an active product type.
  await api.createProductType()
})

test('create, edit, versions (copy, empty, rename, delete) and delete a project', async ({ page }) => {
  const name = unique('Villa')
  await page.goto('/')
  await navigate(page, 'Projects', 'Projects')
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible()

  await page.getByRole('button', { name: 'New project' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.getByRole('textbox', { name: 'Name' }).first().fill(name)
  // The currency only: a new project has no exchange rate until one is set (BOM or Pricing tab, edit dialog).
  await dialog.getByRole('combobox', { name: 'Currency' }).fill('eur')
  await page.getByRole('option', { name: 'EUR – Euro' }).click()
  await expect(dialog.getByLabel('Exchange rate')).toHaveCount(0)
  await dialog.getByLabel('Company').fill('Müller GmbH')
  await dialog.getByRole('button', { name: 'Create' }).click()

  // The new project opens with its first version.
  await expect(page.getByRole('heading', { level: 1 })).toContainText(name)
  await expect(page.getByText('Müller GmbH')).toBeVisible()
  await expect(page.getByLabel('Version', { exact: true })).toHaveText('V1')
  await expect(page.getByText('Start with a floorplan (an image of the building) or a distribution board.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add plan' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Delete version' })).toBeDisabled()

  // Edit: rename and enter the exchange rate by hand; it comes back as stored.
  const renamed = unique('Villa Schmidt')
  await page.getByRole('button', { name: 'Edit project' }).click()
  const edit = page.getByRole('dialog', { name: 'Edit project' })
  await expect(edit.getByLabel('Exchange rate')).toHaveValue('')
  await edit.getByRole('textbox', { name: 'Name' }).first().fill(renamed)
  await edit.getByLabel('Exchange rate').fill('0.92')
  await edit.getByRole('button', { name: 'Update' }).click()
  await expect(edit).toBeHidden()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(renamed)
  await page.getByRole('button', { name: 'Edit project' }).click()
  await expect(edit.getByLabel('Exchange rate')).toHaveValue('0.92')
  await expect(edit.getByText(/entered manually on/)).toBeVisible()
  await edit.getByRole('button', { name: 'Cancel' }).click()
  await expect(edit).toBeHidden()

  // A copy of V1 (the default), named V2.
  await page.getByRole('button', { name: 'New version' }).click()
  const newVersion = page.getByRole('dialog', { name: 'New version' })
  await expect(newVersion.getByLabel('Start from')).toHaveText('Copy of V1')
  await expect(newVersion.getByLabel('Name')).toHaveValue('V2')
  await newVersion.getByRole('button', { name: 'Create' }).click()
  await expect(newVersion).toBeHidden()
  await expect(page.getByLabel('Version', { exact: true })).toHaveText('V2')
  await expect(page).toHaveURL(/\/versions\//)

  // An empty one.
  await page.getByRole('button', { name: 'New version' }).click()
  await newVersion.getByLabel('Start from').click()
  await page.getByRole('option', { name: 'Empty version' }).click()
  await newVersion.getByLabel('Name').fill('Empty start')
  await newVersion.getByRole('button', { name: 'Create' }).click()
  await expect(newVersion).toBeHidden()
  await expect(page.getByLabel('Version', { exact: true })).toHaveText('Empty start')

  // Rename it; a taken name is refused.
  await page.getByRole('button', { name: 'Rename' }).click()
  const rename = page.getByRole('dialog', { name: 'Rename version' })
  await rename.getByLabel('Name').fill('v1')
  await rename.getByRole('button', { name: 'Update' }).click()
  await expect(rename.getByRole('alert')).toHaveText('This project already has a version named "v1".')
  await rename.getByLabel('Name').fill('Offer B')
  await rename.getByRole('button', { name: 'Update' }).click()
  await expect(rename).toBeHidden()
  await expect(page.getByLabel('Version', { exact: true })).toHaveText('Offer B')

  // Delete it: back to the first version.
  await page.getByRole('button', { name: 'Delete version' }).click()
  await page.getByRole('dialog', { name: 'Delete version' }).getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByLabel('Version', { exact: true })).toHaveText('V1')

  // The list: two versions; delete the project.
  await navigate(page, 'Projects', 'Projects')
  await expect(row(page, renamed)).toContainText('Müller GmbH')
  await expect(row(page, renamed)).toContainText('Active')
  await row(page, renamed).getByRole('button', { name: 'Delete' }).click()
  await page.getByRole('dialog', { name: 'Delete project' }).getByRole('button', { name: 'Delete' }).click()
  await expect(row(page, renamed)).toHaveCount(0)
})

test('a completed project is read-only until reopened', async ({ page, api }) => {
  const project = await api.createProject({ status: 'completed' })
  await page.goto('/projects?status=completed')
  await row(page, project.name).getByRole('link', { name: project.name }).click()

  await expect(page.getByText('This project is completed. Reopen it to change it.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit project' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'New version' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Reopen' }).click()
  await expect(page.getByText('This project is completed. Reopen it to change it.')).toBeHidden()
  await expect(page.getByRole('button', { name: 'New version' })).toBeVisible()
  await expect(page.getByText('Active', { exact: true })).toBeVisible()
})

test('a tenant with projects is archived instead of deleted, and restored', async ({ page, api }) => {
  const tenant = await api.createTenant()
  await api.createProject({ tenantId: tenant.id })
  await page.goto('/admin/tenants')
  await row(page, tenant.name).getByRole('button', { name: 'Delete' }).click()
  const dialog = page.getByRole('dialog', { name: 'Archive tenant' })
  await expect(dialog).toContainText('has 1 project, so it is archived instead of deleted')
  await dialog.getByRole('button', { name: 'Archive' }).click()
  await expect(row(page, tenant.name)).toHaveCount(0)

  await page.getByLabel('Show archived').check()
  await expect(row(page, tenant.name)).toContainText('Archived')
  await row(page, tenant.name).getByRole('button', { name: 'Restore' }).click()
  await expect(row(page, tenant.name)).not.toContainText('Archived')
})
