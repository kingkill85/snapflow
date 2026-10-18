import { type Page } from '@playwright/test'

import { type Api, expect, test, unique, uniqueKey } from '../fixtures'

// Every page, dialog and state of projects and versions (step 2a) and the
// tenant archive at phone and desktop width, light and dark, English and
// German: nothing overflows the viewport. Screenshots land in
// e2e/screenshots/project-*.png and tenant-*.png for a look by eye. The data is
// seeded through the API (the flows themselves are tested in projects.spec.ts).
// Tagged @visual: it runs with `make e2e-visual`, not in the default run (D107).

const viewports = [
  { name: 'phone', size: { width: 390, height: 844 } },
  { name: 'desktop', size: { width: 1280, height: 800 } },
]

const labels = {
  en: {
    newProject: 'New project',
    editProject: 'Edit project',
    newVersion: 'New version',
    rename: 'Rename',
    deleteVersion: 'Delete version',
    edit: 'Edit',
    delete: 'Delete',
    create: 'Create',
    start: 'Start from',
    empty: 'Empty version',
    version: 'Version',
    showArchived: 'Show archived',
  },
  de: {
    newProject: 'Neues Projekt',
    editProject: 'Projekt bearbeiten',
    newVersion: 'Neue Version',
    rename: 'Umbenennen',
    deleteVersion: 'Version löschen',
    edit: 'Bearbeiten',
    delete: 'Löschen',
    create: 'Erstellen',
    start: 'Beginnen mit',
    empty: 'Leere Version',
    version: 'Version',
    showArchived: 'Archivierte anzeigen',
  },
}

type Project = { id: string; name: string; updatedAt: string; versions?: { id: string; name: string; updatedAt: string }[] }

async function json<T>(res: Awaited<ReturnType<Api['ctx']['get']>>): Promise<T> {
  expect(res.ok(), `${res.url()}: ${res.status()} ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow, 'page is wider than the viewport').toBeLessThanOrEqual(0)
}

/** The data of one run: long names, notes, an inactive product type, every status, tenants to archive and delete. */
async function seed(api: Api) {
  const tag = uniqueKey('vis')
  const type = await api.createProductType({ name: { en: unique('Zigbee professional line'), de: unique('Zigbee Profi-Linie') }, abbreviation: 'ZB', color: '#1f6feb' })
  const retired = await api.createProductType({ name: { en: unique('Legacy KNX line'), de: unique('Alte KNX-Linie') } })
  const tenant = await api.createTenant(unique('Elektrotechnik Mustermann-Schmidt GmbH & Co. KG'))

  const create = async (data: object) => json<Project>(await api.ctx.post('/api/projects', { data }))
  const main = await create({
    name: `Villa Mustermann-Schmidt, Erweiterung Nebengebäude ${tag}`,
    tenantId: tenant.id,
    customer: { name: 'Maximilian Alexander Mustermann-Schmidt', company: 'Mustermann-Schmidt Immobilienverwaltung GmbH', email: 'max@example.com', phone: '+49 30 1234567', address: 'Hauptstraße 1\n10115 Berlin' },
    notes: 'Customer wants a quote by Friday.',
    productTypeIds: [type.id],
  })
  // A second version with notes, opened by the project page.
  const v2 = await json<{ id: string; name: string; updatedAt: string }>(await api.ctx.post(`/api/projects/${main.id}/versions`, { data: { name: 'Angebot B mit Präsenzmeldern' } }))
  await json(
    await api.ctx.put(`/api/projects/${main.id}/versions/${v2.id}`, {
      data: { name: v2.name, notes: 'Second offer: presence detectors in every room,\nKNX visualisation instead of the app.', expectedUpdatedAt: v2.updatedAt },
    }),
  )

  // Created with a product type that is deactivated afterwards.
  const withRetired = await create({ name: `Bürogebäude Nord ${tag}`, productTypeIds: [type.id, retired.id], customer: { company: 'Nord Immobilien AG' } })
  await api.updateProductType(retired.id, { isActive: false })

  const single = await create({ name: `Einfamilienhaus ${tag}`, customer: { name: 'Erika Musterfrau' } })
  const setStatus = async (p: Project, status: string) => json<Project>(await api.ctx.put(`/api/projects/${p.id}`, { data: { name: p.name, status, expectedUpdatedAt: p.updatedAt } }))
  const completed = await setStatus(await create({ name: `Abgeschlossen ${tag}` }), 'completed')
  const cancelled = await setStatus(await create({ name: `Storniert ${tag}` }), 'cancelled')

  // Tenants: one archived (with a project), one to archive, one to delete.
  const archived = await api.createTenant(unique('Archived Partner Elektro GmbH'))
  await api.createProject({ tenantId: archived.id, name: `Altprojekt ${tag}` })
  const archivedRes = await api.ctx.delete(`/api/tenants/${archived.id}`)
  expect(archivedRes.ok(), await archivedRes.text()).toBe(true)
  const toArchive = await api.createTenant(unique('Partner with projects'))
  await api.createProject({ tenantId: toArchive.id, name: `Partnerprojekt ${tag}` })
  const toDelete = await api.createTenant(unique('Partner without projects'))

  return { tag, main, v2, withRetired, single, completed, cancelled, archived, toArchive, toDelete }
}

for (const lang of ['en', 'de'] as const) {
  for (const viewport of viewports) {
    test(`projects and tenants fit the screen: ${viewport.name}, ${lang}`, { tag: '@visual' }, async ({ page, api, sessionFor }) => {
      test.setTimeout(300_000)
      const l = labels[lang]
      const s = await seed(api)
      const row = (p: Page, text: string) => p.getByRole('row').filter({ hasText: text })
      const dialogShot = { fullPage: false }

      const steps: { name: string; path: string; fullPage?: boolean; act?: (p: Page) => Promise<void> }[] = [
        { name: 'list', path: `/projects?search=${s.tag}` },
        { name: 'list-all-statuses', path: `/projects?search=${s.tag}&status=all` },
        { name: 'list-empty-filtered', path: '/projects?search=nothing-matches-this' },
        {
          name: 'create-dialog',
          path: '/projects',
          ...dialogShot,
          act: async (p) => {
            await p.getByRole('button', { name: l.newProject }).first().click()
            const dialog = p.getByRole('dialog', { name: l.newProject })
            await dialog.getByRole('button', { name: l.create }).click()
            await expect(dialog.locator('[aria-invalid="true"]').first()).toBeVisible()
          },
        },
        {
          name: 'edit-dialog-inactive-type',
          path: `/projects?search=${s.tag}`,
          ...dialogShot,
          act: async (p) => {
            await row(p, s.withRetired.name).getByRole('button', { name: l.edit }).click()
            await expect(p.getByRole('dialog', { name: l.editProject })).toBeVisible()
          },
        },
        {
          name: 'delete-project',
          path: `/projects?search=${s.tag}`,
          ...dialogShot,
          act: async (p) => {
            await row(p, s.single.name).getByRole('button', { name: l.delete }).click()
            await expect(p.getByRole('dialog')).toBeVisible()
          },
        },
        { name: 'page', path: `/projects/${s.main.id}/versions/${s.v2.id}` },
        {
          name: 'page-switcher',
          path: `/projects/${s.main.id}/versions/${s.v2.id}`,
          ...dialogShot,
          act: async (p) => {
            await p.getByLabel(l.version, { exact: true }).click()
            await expect(p.getByRole('option').first()).toBeVisible()
          },
        },
        {
          name: 'new-version-copy',
          path: `/projects/${s.main.id}/versions/${s.v2.id}`,
          ...dialogShot,
          act: async (p) => {
            await p.getByRole('button', { name: l.newVersion }).click()
            await expect(p.getByRole('dialog', { name: l.newVersion })).toBeVisible()
          },
        },
        {
          name: 'new-version-empty',
          path: `/projects/${s.main.id}/versions/${s.v2.id}`,
          ...dialogShot,
          act: async (p) => {
            await p.getByRole('button', { name: l.newVersion }).click()
            const dialog = p.getByRole('dialog', { name: l.newVersion })
            await dialog.getByLabel(l.start).click()
            await p.getByRole('option', { name: l.empty }).click()
          },
        },
        {
          name: 'rename-version',
          path: `/projects/${s.main.id}/versions/${s.v2.id}`,
          ...dialogShot,
          act: async (p) => {
            await p.getByRole('button', { name: l.rename }).click()
            await expect(p.getByRole('dialog')).toBeVisible()
          },
        },
        {
          name: 'delete-version',
          path: `/projects/${s.main.id}/versions/${s.v2.id}`,
          ...dialogShot,
          act: async (p) => {
            await p.getByRole('button', { name: l.deleteVersion }).click()
            await expect(p.getByRole('dialog')).toBeVisible()
          },
        },
        { name: 'page-single-version', path: `/projects/${s.single.id}` },
        { name: 'page-completed', path: `/projects/${s.completed.id}` },
        { name: 'page-cancelled', path: `/projects/${s.cancelled.id}` },
        {
          name: 'tenants-archived',
          path: '/admin/tenants',
          act: async (p) => {
            await p.getByLabel(l.showArchived).check()
            await expect(row(p, s.archived.name)).toBeVisible()
          },
        },
        {
          name: 'tenant-archive-confirm',
          path: '/admin/tenants',
          ...dialogShot,
          act: async (p) => {
            await row(p, s.toArchive.name).getByRole('button', { name: l.delete }).click()
            await expect(p.getByRole('dialog')).toBeVisible()
          },
        },
        {
          name: 'tenant-delete-confirm',
          path: '/admin/tenants',
          ...dialogShot,
          act: async (p) => {
            await row(p, s.toDelete.name).getByRole('button', { name: l.delete }).click()
            await expect(p.getByRole('dialog')).toBeVisible()
          },
        },
        {
          name: 'tenant-dialog-archived',
          path: '/admin/tenants',
          ...dialogShot,
          act: async (p) => {
            await p.getByLabel(l.showArchived).check()
            await row(p, s.archived.name).getByRole('button', { name: l.edit }).click()
            await expect(p.getByRole('dialog')).toBeVisible()
          },
        },
      ]

      // A user of a tenant without projects: the list's empty state.
      const tenant = await api.createTenant(unique('Empty partner'))
      const user = await api.createUser({ tenantId: tenant.id, role: 'tenant_admin' })
      const other = await sessionFor(user)

      for (const p of [page, other]) await p.addInitScript((lng) => window.localStorage.setItem('i18nextLng', lng), lang)
      for (const colorScheme of ['light', 'dark'] as const) {
        for (const p of [page, other]) {
          await p.setViewportSize(viewport.size)
          await p.emulateMedia({ colorScheme })
        }
        const shoot = async (p: Page, name: string, fullPage: boolean) => {
          await expectNoHorizontalOverflow(p)
          await p.screenshot({ path: `e2e/screenshots/project-${name}-${viewport.name}-${colorScheme}-${lang}.png`, fullPage })
        }
        for (const step of steps) {
          await page.goto(step.path)
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
          await page.waitForLoadState('networkidle')
          await expect(page.getByRole('status').filter({ hasText: /^(Loading…|Wird geladen…)$/ })).toHaveCount(0)
          if (step.act) await step.act(page)
          await shoot(page, step.name, step.fullPage ?? true)
          await page.keyboard.press('Escape')
        }
        await other.goto('/projects')
        await expect(other.getByRole('heading', { level: 1 })).toBeVisible()
        await other.waitForLoadState('networkidle')
        await shoot(other, 'list-empty', true)
      }
    })
  }
}
