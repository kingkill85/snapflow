import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'

import type { ImportMapping } from '@/api/generated/model'
import { renderRoutes } from '@/test/render'
import { server } from '@/test/server'
import { chooseOption } from '@/test/select'

import { ImportRunPage } from './ImportRunPage'
import { gateways, id, lookups, mapping, previewed, previewHandler, previewLists, problem, profile, run, runHandlers, zigbee } from './test-fixtures'

// The mapping step's review fixes: errors of a profile at its own fields,
// sheets the file lacks, unsaved changes, add-on order, the running
// preview, fixed values, custom attribute keys and further mappings.

const routes = [
  { path: '/catalog/imports', element: <p>runs</p> },
  { path: '/catalog/imports/:id', element: <ImportRunPage /> },
]
const runRoute = `/catalog/imports/${id(1)}`
const targetSelect = (column: string) => screen.getByRole('combobox', { name: `Imported as: ${column}` })

vi.setConfig({ testTimeout: 20_000 })

/** A mapping on a sheet the file (sheets Items and Notes) lacks. */
const gone: ImportMapping = { ...mapping, sheet: 'Gone' }
const sheetMissing = (q: URLSearchParams) =>
  q.get('sheet') === 'Gone' ? problem(422, { code: 'import.sheet_not_found', params: { sheet: 'Gone' } }) : undefined

describe('MappingStep: profiles', () => {
  it("shows a profile's preview errors at the rows of its own fields, also reordered and with a column the file lacks", async () => {
    // The profile lists the category first and a column the file lacks second: not the form's order.
    const reordered = profile({
      mapping: {
        ...mapping,
        fields: [
          { target: 'product.category', column: 'Category', columnLetter: 'C' },
          { target: 'variant.sku', column: 'SKU', columnLetter: 'E' },
          { target: 'product.name.en', column: 'Name', columnLetter: 'B' },
          { target: 'product.modelNumber', column: 'Model Number', columnLetter: 'A' },
        ],
      },
    })
    lookups([reordered])
    server.use(http.get(`/api/import-profiles/${reordered.id}`, () => HttpResponse.json(reordered)))
    runHandlers(() => run())
    const bodies = previewHandler(() =>
      problem(422, {
        code: 'validation.failed',
        fields: [
          { location: 'mapping.fields[0].columnLetter', code: 'import_profile.column_letter' },
          { location: 'mapping.fields[1].column', code: 'import.column_missing', params: { column: 'SKU' } },
        ],
      }),
    )
    const { router } = renderRoutes(routes, { route: `${runRoute}?profile=${reordered.id}` })

    await waitFor(() => expect(bodies).toEqual([{ profileId: reordered.id }]))
    expect(await screen.findByText('Enter a column letter such as A, K or AB.')).toBeInTheDocument()
    expect(targetSelect('Category')).toHaveAttribute('aria-invalid', 'true')
    expect(targetSelect('Model Number')).not.toHaveAttribute('aria-invalid')
    const extras = screen.getByRole('region', { name: 'Further mappings' })
    expect(within(extras).getByText('The file has no column "SKU".')).toBeInTheDocument()
    // The preview settled: a reload does not start it again.
    await waitFor(() => expect(router.state.location.search).toBe(''))
  })

  it('asks before a profile replaces unsaved changes; leaving asks too', async () => {
    lookups([profile()])
    runHandlers(() => run())
    const user = userEvent.setup()
    const { router } = renderRoutes(routes, { route: runRoute })

    await chooseOption(user, await screen.findByRole('combobox', { name: 'Imported as: Price' }), 'Price (USD)')
    // Something is unsaved: the way out says so, and asks.
    await user.click(screen.getByRole('link', { name: 'Cancel' }))
    const leave = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })
    await user.click(within(leave).getByRole('button', { name: 'Stay' }))
    expect(router.state.location.pathname).toBe(runRoute)

    await chooseOption(user, screen.getByRole('combobox', { name: 'Saved mapping' }), 'Supplier A')
    const replace = await screen.findByRole('dialog', { name: 'Load saved mapping' })
    expect(replace).toHaveTextContent('Load the saved mapping "Supplier A"? It replaces the changes you made to the mapping.')
    await user.click(within(replace).getByRole('button', { name: 'Load mapping' }))
    await waitFor(() => expect(targetSelect('Model Number')).toHaveTextContent('Model number (required)'))
    expect(targetSelect('Price')).toHaveTextContent('Not imported')
    // Loaded, nothing is unsaved.
    expect(screen.queryByRole('link', { name: 'Cancel' })).not.toBeInTheDocument()
  })

  it('deletes the profile after confirming; the actions follow what the profile allows', async () => {
    let profiles = [profile(), profile({ id: id(303), name: 'Read only', can: { update: false, delete: false } })]
    lookups()
    server.use(
      http.get('/api/import-profiles', () => HttpResponse.json(profiles)),
      http.delete(`/api/import-profiles/${profile().id}`, () => {
        profiles = profiles.slice(1)
        return new HttpResponse(null, { status: 204 })
      }),
    )
    runHandlers(() => run())
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })

    await chooseOption(user, await screen.findByRole('combobox', { name: 'Saved mapping' }), 'Read only')
    await waitFor(() => expect(targetSelect('Model Number')).toHaveTextContent('Model number (required)'))
    expect(screen.queryByRole('button', { name: 'Delete saved mapping' })).not.toBeInTheDocument()
    await chooseOption(user, targetSelect('Price'), 'Price (USD)')
    expect(screen.getByText(/The mapping differs from the saved mapping "Read only"/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update saved mapping' })).not.toBeInTheDocument()

    await chooseOption(user, screen.getByRole('combobox', { name: 'Saved mapping' }), 'Supplier A')
    await user.click(within(await screen.findByRole('dialog', { name: 'Load saved mapping' })).getByRole('button', { name: 'Load mapping' }))
    await user.click(await screen.findByRole('button', { name: 'Delete saved mapping' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete saved mapping' })
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Saved mapping' })).toHaveTextContent('None'))
    await user.click(screen.getByRole('combobox', { name: 'Saved mapping' }))
    expect(screen.queryByRole('option', { name: 'Supplier A' })).not.toBeInTheDocument()
  })

  it("keeps a profile's add-on order, so the preview still uses the profile", async () => {
    // Name (B) before Price (D): not the file's column order.
    const addons = profile({
      mapping: {
        ...mapping,
        categoryId: gateways.id,
        fields: [
          { target: 'product.modelNumber', column: 'Model Number', columnLetter: 'A' },
          { target: 'addon.required', column: 'Price', columnLetter: 'D' },
          { target: 'addon.required', column: 'Name', columnLetter: 'B' },
        ],
      },
    })
    lookups([addons])
    runHandlers(() => run())
    const bodies = previewHandler(() => HttpResponse.json(previewed()))
    previewLists()
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })
    await chooseOption(user, await screen.findByRole('combobox', { name: 'Saved mapping' }), 'Supplier A')
    await waitFor(() => expect(targetSelect('Price')).toHaveTextContent('Required add-on'))
    expect(screen.queryByText(/The mapping differs/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    await waitFor(() => expect(bodies).toEqual([{ profileId: addons.id }]))
  })
})

describe('MappingStep: sheets', () => {
  it('shows a sheet the file lacks at the sheet and places the mapping on the sheet chosen instead', async () => {
    lookups([])
    const { sourceQueries } = runHandlers(() => run({ mapping: gone }), sheetMissing)
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })

    const sheet = await screen.findByRole('combobox', { name: 'Sheet' })
    expect(sheet).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('The file has no sheet "Gone".')).toBeInTheDocument()
    expect(screen.getByText("Choose one of the file's sheets to see its columns.")).toBeInTheDocument()

    await chooseOption(user, sheet, 'Notes')
    await waitFor(() => expect(targetSelect('Model Number')).toHaveTextContent('Model number (required)'))
    expect(targetSelect('Category')).toHaveTextContent('Category (required)')
    expect(sourceQueries.at(-1)?.get('sheet')).toBe('Notes')
    expect(screen.getByRole('combobox', { name: 'Sheet' })).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByRole('region', { name: 'Further mappings' })).not.toBeInTheDocument()
  })

  it('goes back to the first sheet when "None" replaces a profile whose sheet the file lacks', async () => {
    const p = profile({ mapping: gone })
    lookups([p])
    const { sourceQueries } = runHandlers(() => run({ mapping: gone, profileId: p.id, profileName: p.name }), sheetMissing)
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })

    expect(await screen.findByRole('combobox', { name: 'Sheet' })).toHaveAccessibleDescription('The file has no sheet "Gone".')
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Saved mapping' })).toHaveTextContent('Supplier A'))
    await chooseOption(user, screen.getByRole('combobox', { name: 'Saved mapping' }), 'None')
    await waitFor(() => expect(targetSelect('Model Number')).toHaveTextContent('Model number (required)'))
    expect(sourceQueries.at(-1)?.get('sheet')).toBeNull()
    expect(screen.queryByText('The file has no sheet "Gone".')).not.toBeInTheDocument()
  })
})

describe('MappingStep: preview', () => {
  it('shows the running preview for the whole step and keeps the form unchangeable meanwhile', async () => {
    lookups([])
    runHandlers(() => run({ mapping }))
    previewHandler(() => new Promise<Response>(() => {}))
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })

    await user.click(await screen.findByRole('button', { name: 'Preview' }))
    const status = (await screen.findByText('Reading the file…', { selector: 'p' })).closest('[role="status"]')
    expect(status).not.toBeNull()
    expect(status).toHaveTextContent('Comparing 2 data rows with the catalog.')
    expect(screen.getByLabelText('Header row')).toBeDisabled()
    expect(targetSelect('Name')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reading the file…' })).toBeDisabled()
  })

  it('reloads the run when it changed state meanwhile (import.state)', async () => {
    lookups([])
    let gets = 0
    runHandlers(() => run({ mapping }))
    server.use(
      http.get(`/api/imports/${id(1)}`, () => {
        gets++
        return HttpResponse.json(run({ mapping }))
      }),
    )
    previewHandler(() => problem(409, { code: 'import.state', params: { state: 'applied' } }))
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })

    await user.click(await screen.findByRole('button', { name: 'Preview' }))
    expect(await screen.findByText("This is not possible in the import's current state. Reload it.")).toBeInTheDocument()
    await waitFor(() => expect(gets).toBe(2))
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(gets).toBe(3))
  })

  it('sends an attribute key typed in and shows errors at it and at fixed values', async () => {
    lookups([])
    runHandlers(() => run())
    const bodies = previewHandler(() =>
      problem(422, {
        code: 'validation.failed',
        fields: [
          { location: 'body.mapping.fields[1].target', code: 'import_profile.target_unknown' },
          { location: 'body.mapping.fields[2].value', code: 'import_profile.constant_not_allowed' },
        ],
      }),
    )
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })

    await chooseOption(user, await screen.findByRole('combobox', { name: 'Imported as: Model Number' }), 'Model number (required)')
    await chooseOption(user, targetSelect('Price'), 'Other attribute (enter its key)…')
    await user.type(screen.getByRole('textbox', { name: 'Attribute key for Price' }), ' dimensions ')
    await user.click(screen.getByRole('button', { name: 'Add fixed value' }))
    const constant = screen.getByRole('group', { name: 'Fixed value 1' })
    await chooseOption(user, within(constant).getByRole('combobox', { name: 'Field' }), 'Product name (English)')
    await user.type(within(constant).getByRole('textbox', { name: 'Value' }), 'Gateway')
    await user.click(screen.getByRole('button', { name: 'Preview' }))

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0].mapping?.fields).toEqual([
      { target: 'product.modelNumber', column: 'Model Number', columnLetter: 'A' },
      { target: 'attribute.dimensions', column: 'Price', columnLetter: 'D' },
      { target: 'product.name.en', value: 'Gateway' },
    ])
    const key = screen.getByRole('textbox', { name: 'Attribute key for Price' })
    expect(await screen.findByText('This target does not exist.')).toBeInTheDocument()
    expect(key).toHaveAttribute('aria-invalid', 'true')
    expect(key).toHaveAccessibleDescription('This target does not exist.')
    const value = within(constant).getByRole('textbox', { name: 'Value' })
    expect(value).toHaveAttribute('aria-invalid', 'true')
    expect(value).toHaveAccessibleDescription('This target cannot take a fixed value.')
    expect(within(constant).getByRole('combobox', { name: 'Field' })).toHaveAttribute('aria-invalid', 'true')
  })

  it('removes a further mapping of a column the file lacks', async () => {
    const extra = profile({
      mapping: { ...mapping, fields: [...mapping.fields, { target: 'variant.sku', column: 'SKU', columnLetter: 'E' }] },
    })
    lookups([extra])
    runHandlers(() => run())
    const bodies = previewHandler(() => HttpResponse.json(previewed()))
    previewLists()
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })

    await chooseOption(user, await screen.findByRole('combobox', { name: 'Saved mapping' }), 'Supplier A')
    const extras = await screen.findByRole('region', { name: 'Further mappings' })
    expect(extras).toHaveTextContent('SKU←SKU (column E)')
    await user.click(within(extras).getByRole('button', { name: 'Remove' }))
    expect(screen.queryByRole('region', { name: 'Further mappings' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Preview' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    // Not the profile any more: the mapping as shown.
    expect(bodies[0].profileId).toBeUndefined()
    expect(bodies[0].mapping?.fields.map((f) => f.target)).toEqual(['product.modelNumber', 'product.name.en', 'product.category'])
    expect(bodies[0].mapping?.productTypeId).toBe(zigbee.id)
  })
})
