import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'

import type { ImportMapping, ImportRun } from '@/api/generated/model'
import { renderRoutes } from '@/test/render'
import { server } from '@/test/server'
import { chooseOption } from '@/test/select'

import { ImportRunPage } from './ImportRunPage'
import { NewImportPage } from './NewImportPage'
import {
  applied,
  changes,
  counts,
  gateways,
  id,
  issue,
  lookups,
  mapping,
  previewed,
  problem,
  productItem,
  profile,
  run,
  source,
  variantItem,
  zigbee,
} from './test-fixtures'

const routes = [
  { path: '/catalog/imports', element: <p>runs</p> },
  { path: '/catalog/imports/new', element: <NewImportPage /> },
  { path: '/catalog/imports/:id', element: <ImportRunPage /> },
]
const runRoute = `/catalog/imports/${id(1)}`

/** Serves the run (as `current()` says) and its source preview; records source queries. */
function runHandlers(current: () => ImportRun) {
  const sourceQueries: URLSearchParams[] = []
  server.use(
    http.get(`/api/imports/${id(1)}`, () => HttpResponse.json(current())),
    http.get(`/api/imports/${id(1)}/source`, ({ request }) => {
      const q = new URL(request.url).searchParams
      sourceQueries.push(q)
      const headerRow = Number(q.get('headerRow'))
      return HttpResponse.json({ ...source, headerRow })
    }),
  )
  return { sourceQueries }
}

/** Records preview requests and answers with `answer`. */
function previewHandler(answer: (body: { mapping?: ImportMapping; profileId?: string }) => Response | Promise<Response>) {
  const bodies: { mapping?: ImportMapping; profileId?: string }[] = []
  server.use(
    http.post(`/api/imports/${id(1)}/preview`, async ({ request }) => {
      const body = (await request.json()) as { mapping?: ImportMapping; profileId?: string }
      bodies.push(body)
      return answer(body)
    }),
  )
  return bodies
}

function previewLists(items = [productItem, variantItem], issues = [issue], total?: number) {
  const itemQueries: URLSearchParams[] = []
  const issueQueries: URLSearchParams[] = []
  server.use(
    http.get(`/api/imports/${id(1)}/items`, ({ request }) => {
      itemQueries.push(new URL(request.url).searchParams)
      return HttpResponse.json({ items, total: total ?? items.length })
    }),
    http.get(`/api/imports/${id(1)}/issues`, ({ request }) => {
      issueQueries.push(new URL(request.url).searchParams)
      return HttpResponse.json({ items: issues, total: issues.length })
    }),
  )
  return { itemQueries, issueQueries }
}

const targetSelect = (column: string) => screen.getByRole('combobox', { name: `Imported as: ${column}` })

// Long flows through many dropdowns: more time than the default 5 s on a busy machine.
vi.setConfig({ testTimeout: 20_000 })

describe('ImportRunPage: mapping', () => {
  it('shows the source and maps columns to grouped targets, a fixed type and a constant; Preview sends the mapping', async () => {
    lookups([])
    let state: ImportRun = run()
    runHandlers(() => state)
    previewLists()
    const bodies = previewHandler(() => {
      state = previewed()
      return HttpResponse.json(state)
    })
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })

    expect(await screen.findByRole('heading', { name: 'supplier.xlsx', level: 1 })).toBeInTheDocument()
    expect(screen.getByText(/Uploaded by Ada Admin/)).toHaveTextContent('0.1 MB')
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Mapping')
    // The source: the first rows with the picture marker.
    expect(await screen.findByText('2 data rows, 4 columns, 1 pictures')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'A · Model Number' })).toBeInTheDocument()
    expect(screen.getByTitle('1 picture over this row')).toBeInTheDocument()

    // Targets are grouped; the category's attributes are offered by label and key.
    await user.click(targetSelect('Price'))
    const groups = await screen.findAllByRole('group')
    expect(groups.map((g) => g.firstChild?.textContent)).toEqual(['Product', 'Variant', 'Add-ons', 'Attributes'])
    expect(within(groups[3]).getByRole('option', { name: 'Width (width_te)' })).toBeInTheDocument()
    expect(within(groups[0]).getByRole('option', { name: 'Model number (required)' })).toBeInTheDocument()
    await user.click(within(groups[1]).getByRole('option', { name: 'Price (USD)' }))

    await chooseOption(user, targetSelect('Model Number'), 'Model number (required)')
    // A single target another column has is not offered twice.
    await user.click(targetSelect('Name'))
    expect(screen.getByRole('option', { name: 'Model number (required)' })).toHaveAttribute('aria-disabled', 'true')
    await user.click(screen.getByRole('option', { name: 'Product name (English)' }))
    // Choosing the category column turns the category to "from a column".
    await chooseOption(user, targetSelect('Category'), 'Category (required)')
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveTextContent('From a column')
    await chooseOption(user, screen.getByRole('combobox', { name: 'Product type' }), 'Zigbee')

    await user.click(screen.getByRole('button', { name: 'Add fixed value' }))
    await chooseOption(user, screen.getByRole('combobox', { name: 'Field of fixed value 1' }), 'Width (width_te)')
    await user.type(screen.getByRole('textbox', { name: 'Value of fixed value 1' }), '4')
    await user.click(screen.getByLabelText('Pictures from any column'))
    await user.click(screen.getByLabelText('All or nothing'))

    await user.click(screen.getByRole('button', { name: 'Preview' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({
      mapping: {
        sourceKind: 'xlsx',
        headerRow: 1,
        dataStartRow: 2,
        productTypeId: zigbee.id,
        createMissingCategories: false,
        allOrNothing: false,
        fields: [
          { target: 'product.modelNumber', column: 'Model Number', columnLetter: 'A' },
          { target: 'product.name.en', column: 'Name', columnLetter: 'B' },
          { target: 'product.category', column: 'Category', columnLetter: 'C' },
          { target: 'variant.price', column: 'Price', columnLetter: 'D' },
          { target: 'variant.image' },
          { target: 'attribute.width_te', value: '4' },
        ],
      },
    })
    expect(await screen.findByRole('heading', { name: 'Preview' })).toBeInTheDocument()
  })

  it('reloads the source for another header row and shows mapping errors at their rows', async () => {
    lookups([])
    const { sourceQueries } = runHandlers(() => run())
    previewHandler(() =>
      problem(422, {
        code: 'validation.failed',
        fields: [
          { location: 'body.mapping.fields[0].column', code: 'import.column_missing', params: { column: 'Model Number' } },
          { location: 'body.mapping.fields', code: 'import_profile.product_type_required' },
          { location: 'body.mapping.fields', code: 'import_profile.category_required' },
          { location: 'body.mapping.dataStartRow', code: 'import_profile.data_start_row' },
        ],
      }),
    )
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })

    const header = await screen.findByLabelText('Header row')
    await user.clear(header)
    await user.type(header, '3')
    await waitFor(() => expect(sourceQueries.at(-1)?.get('headerRow')).toBe('3'))
    // The first data row follows the header row.
    expect(screen.getByLabelText('First data row')).toHaveValue(4)

    await chooseOption(user, targetSelect('Model Number'), 'Model number (required)')
    await user.click(screen.getByRole('button', { name: 'Preview' }))

    expect(await screen.findByText('The file has no column "Model Number".')).toBeInTheDocument()
    expect(targetSelect('Model Number')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Map the product type or choose a fixed one.')).toBeInTheDocument()
    expect(screen.getByText('Map the category or choose a fixed one.')).toBeInTheDocument()
    expect(screen.getByText('The data must start below the header row.')).toBeInTheDocument()
    expect(screen.getByRole('alert', { name: '' })).toHaveTextContent('Please check the highlighted fields.')
  })

  it('saves the mapping as a profile, updates it, and offers a reload when it changed meanwhile', async () => {
    let profiles = [profile()]
    lookups([])
    server.use(http.get('/api/import-profiles', () => HttpResponse.json(profiles)))
    runHandlers(() => run())
    const previews = previewHandler(() => HttpResponse.json(previewed()))
    let created: { name: string; mapping: ImportMapping } | undefined
    let updates = 0
    server.use(
      http.post('/api/import-profiles', async ({ request }) => {
        created = (await request.json()) as typeof created
        const p = profile({ id: id(302), name: created!.name, mapping: created!.mapping, updatedAt: '2026-10-18T13:00:00Z' })
        profiles = [...profiles, p]
        return HttpResponse.json(p, { status: 201 })
      }),
      http.put(`/api/import-profiles/${id(302)}`, async ({ request }) => {
        updates++
        const body = (await request.json()) as { expectedUpdatedAt: string }
        expect(body.expectedUpdatedAt).toBe('2026-10-18T13:00:00Z')
        if (updates === 1) return HttpResponse.json(profile({ id: id(302), name: 'Mine', updatedAt: '2026-10-18T14:00:00Z' }))
        return problem(409, { code: 'import_profile.stale' })
      }),
    )
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })

    await chooseOption(user, await screen.findByRole('combobox', { name: 'Imported as: Model Number' }), 'Model number (required)')
    await user.click(screen.getByRole('button', { name: 'Save as new profile' }))
    const dialog = await screen.findByRole('dialog', { name: 'Save as profile' })
    const name = within(dialog).getByLabelText('Profile name')
    expect(name).toHaveValue('supplier')
    await user.clear(name)
    await user.type(name, 'Mine')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    expect(await screen.findByText('Profile "Mine" created.')).toBeInTheDocument()
    // Saving the profile does not submit the mapping form around the dialog.
    expect(previews).toEqual([])
    expect(created?.mapping.fields).toEqual([{ target: 'product.modelNumber', column: 'Model Number', columnLetter: 'A' }])
    expect(screen.getByRole('combobox', { name: 'Profile' })).toHaveTextContent('Mine')

    await user.click(screen.getByRole('button', { name: 'Update profile' }))
    expect(await screen.findByText('Profile saved.')).toBeInTheDocument()
    // The second update finds the profile changed since: Reload loads it as it is now.
    server.use(
      http.put(`/api/import-profiles/${id(302)}`, () => problem(409, { code: 'import_profile.stale' })),
    )
    await user.click(screen.getByRole('button', { name: 'Update profile' }))
    expect(await screen.findByText(/Someone else changed this profile/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload profile' })).toBeInTheDocument()
  })

  it('loads a saved profile into the form, its columns matched by header', async () => {
    lookups([profile()])
    runHandlers(() => run())
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })
    await chooseOption(user, await screen.findByRole('combobox', { name: 'Profile' }), 'Supplier A')
    await waitFor(() => expect(targetSelect('Model Number')).toHaveTextContent('Model number (required)'))
    expect(targetSelect('Name')).toHaveTextContent('Product name (English)')
    expect(targetSelect('Category')).toHaveTextContent('Category (required)')
    expect(screen.getByRole('combobox', { name: 'Product type' })).toHaveTextContent('Zigbee')
  })

  it('previews at once with the profile chosen with the upload, and shows a failing preview at the mapping', async () => {
    lookups([profile()])
    server.use(
      http.get(`/api/import-profiles/${profile().id}`, () => HttpResponse.json(profile())),
      http.post('/api/imports', () => HttpResponse.json(run(), { status: 201 })),
    )
    runHandlers(() => run())
    const bodies = previewHandler(() =>
      problem(422, { code: 'validation.failed', fields: [{ location: 'mapping.fields[2].column', code: 'import.column_missing', params: { column: 'Category' } }] }),
    )
    const user = userEvent.setup()
    renderRoutes(routes, { route: '/catalog/imports/new' })
    await user.upload(await screen.findByLabelText('File to import'), new File(['x'], 'supplier.xlsx'))
    await chooseOption(user, screen.getByRole('combobox', { name: 'Profile' }), 'Supplier A')
    await user.click(screen.getByRole('button', { name: 'Upload and preview' }))

    await waitFor(() => expect(bodies).toEqual([{ profileId: profile().id }]))
    expect(await screen.findByText('The file has no column "Category".')).toBeInTheDocument()
    expect(targetSelect('Category')).toHaveAttribute('aria-invalid', 'true')
  })
})

describe('ImportRunPage: preview', () => {
  it('shows the counters, the changes with before and after, and the issues translated', async () => {
    lookups()
    runHandlers(() => previewed({ counts: counts({ errors: 1, rowsSkipped: 1, unmapped: [{ letter: 'E', header: 'Notes' }] }) }))
    previewLists()
    renderRoutes(routes, { route: runRoute })

    const products = (await screen.findByRole('heading', { name: 'Products' })).parentElement!
    expect(products).toHaveTextContent('New2Changed1Unchanged4To deactivate1')
    expect(screen.getByText('1 column is not imported:')).toBeInTheDocument()
    expect(screen.getByText('E · Notes')).toBeInTheDocument()

    const product = (await screen.findByRole('link', { name: 'GW-1 · Gateway' })).closest('li')!
    expect(screen.getByRole('link', { name: 'GW-1 · Gateway' })).toHaveAttribute('href', `/catalog/products/${id(501)}`)
    expect(product).toHaveTextContent('Rows 2–4, 7')
    expect(product).toHaveTextContent('Name (English)Before: Old gatewayAfter: Gateway')
    expect(product).toHaveTextContent('WidthBefore: 2After: 4')

    const variant = screen.getByText('GW-1 · Black · SKU GW-1 Black').closest('li')!
    expect(variant).toHaveTextContent('Row errors: skipped')
    expect(variant).toHaveTextContent('$27.50')
    expect(within(variant).getByRole('img', { name: 'Image' })).toHaveAttribute('src', `/api/files/${id(902)}`)
    expect(variant).toHaveTextContent('PSU-1required')

    const issueRow = (await screen.findByText('The SKU "GW-1 Black" appears more than once in the file.')).closest('li')!
    expect(issueRow).toHaveTextContent('Error')
    expect(issueRow).toHaveTextContent('Row 5 · D · Price · Price (USD) · GW-1')
    expect(screen.getByText(/1 row has errors: with "All or nothing"/)).toBeInTheDocument()
  })

  it('filters and pages the changes and the issues through the URL', async () => {
    lookups()
    runHandlers(() => previewed({ counts: counts({ errors: 1 }) }))
    const { itemQueries, issueQueries } = previewLists([productItem], [issue], 120)
    const user = userEvent.setup()
    const { router } = renderRoutes(routes, { route: runRoute })

    await screen.findByRole('link', { name: 'GW-1 · Gateway' })
    await chooseOption(user, screen.getByRole('combobox', { name: 'Kind' }), 'Product')
    await chooseOption(user, screen.getByRole('combobox', { name: 'Change' }), 'Changed')
    await user.click(screen.getByLabelText('Only rows with errors'))
    await waitFor(() => expect(Object.fromEntries(itemQueries.at(-1)!)).toEqual({ entity: 'product', status: 'changed', skipped: 'true', limit: '50', offset: '0' }))
    expect(router.state.location.search).toBe('?entity=product&status=changed&skipped=1')

    await user.click(within(screen.getByRole('region', { name: 'Changes' })).getByRole('button', { name: /Next/ }))
    await waitFor(() => expect(itemQueries.at(-1)?.get('offset')).toBe('50'))

    await chooseOption(user, screen.getByRole('combobox', { name: 'Show' }), 'Warnings')
    await waitFor(() => expect(issueQueries.at(-1)?.get('severity')).toBe('warning'))
    // The changes keep their page.
    expect(itemQueries.at(-1)?.get('offset')).toBe('50')

    // A counter filters the changes.
    await user.click(screen.getByRole('link', { name: 'To deactivate' }))
    await waitFor(() => expect(Object.fromEntries(itemQueries.at(-1)!)).toMatchObject({ entity: 'product', status: 'deactivate', offset: '0' }))
  })

  it('applies; a stale preview is previewed again, rows with errors refuse the apply', async () => {
    lookups()
    let state: ImportRun = previewed()
    runHandlers(() => state)
    previewLists([productItem], [])
    const applies: unknown[] = []
    let answer = () => problem(409, { code: 'import.stale' })
    server.use(
      http.post(`/api/imports/${id(1)}/apply`, async ({ request }) => {
        applies.push(await request.json())
        return answer()
      }),
    )
    const bodies = previewHandler(() => HttpResponse.json(previewed()))
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })

    await user.click(await screen.findByRole('button', { name: 'Apply import' }))
    expect(await screen.findByText('The catalog was changed since the preview. Run the preview again.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Preview again' }))
    await waitFor(() => expect(bodies).toEqual([{ mapping }]))
    expect(screen.queryByText(/The catalog was changed/)).not.toBeInTheDocument()

    answer = () => problem(422, { code: 'import.has_errors', params: { count: 3 } })
    await user.click(screen.getByRole('button', { name: 'Apply import' }))
    expect(await screen.findByText(/Rows have errors \(3\)/)).toBeInTheDocument()

    // Skipping the rows with errors: the apply goes through.
    await user.click(screen.getByLabelText('All or nothing'))
    answer = () => {
      state = applied()
      return HttpResponse.json(state)
    }
    server.use(http.get(`/api/imports/${id(1)}/changes`, () => HttpResponse.json({ items: [], total: 0 })))
    await user.click(screen.getByRole('button', { name: 'Apply import' }))
    expect(await screen.findByText(/The import was applied on/)).toBeInTheDocument()
    expect(applies.at(-1)).toEqual({ allOrNothing: false })
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Result')
  })

  it('goes back to the mapping with the run\'s mapping', async () => {
    lookups([])
    runHandlers(() => previewed())
    previewLists()
    const user = userEvent.setup()
    const { router } = renderRoutes(routes, { route: runRoute })
    await user.click(await screen.findByRole('button', { name: 'Edit mapping' }))
    expect(router.state.location.search).toBe('?view=mapping')
    await waitFor(() => expect(targetSelect('Category')).toHaveTextContent('Category (required)'))
    expect(screen.getByRole('combobox', { name: 'Product type' })).toHaveTextContent('Zigbee')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('heading', { name: 'Preview' })).toBeInTheDocument()
  })
})

describe('ImportRunPage: result', () => {
  it('shows what was written, the change log paged without a cut-off, and undoes', async () => {
    lookups()
    let state: ImportRun = applied()
    runHandlers(() => state)
    const queries: URLSearchParams[] = []
    server.use(
      http.get(`/api/imports/${id(1)}/changes`, ({ request }) => {
        queries.push(new URL(request.url).searchParams)
        return HttpResponse.json({ items: changes, total: 642 })
      }),
      http.post(`/api/imports/${id(1)}/undo`, () => {
        state = applied({ state: 'undone', undoneAt: '2026-10-18T15:00:00Z', can: { preview: false, apply: false, undo: false } })
        return HttpResponse.json(state)
      }),
    )
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })

    expect(await screen.findByText(/The import was applied on/)).toBeInTheDocument()
    expect((await screen.findByRole('heading', { name: 'Products' })).parentElement).toHaveTextContent('Created2Updated1')
    expect(await screen.findByText('Every change the import wrote (642), in the order it wrote them.')).toBeInTheDocument()
    const product = screen.getByRole('link', { name: 'GW-1' }).closest('li')!
    expect(product).toHaveTextContent('UpdatedProduct')
    expect(product).toHaveTextContent('Name (English)Before: Old gatewayAfter: Gateway')
    expect(product).not.toHaveTextContent('Model number')
    expect(screen.getByRole('link', { name: 'GW-1 Black' })).toHaveAttribute('href', `/catalog/products/${id(501)}/variants/${id(601)}`)
    expect(screen.getByText('1–50 of 642')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Next/ }))
    await waitFor(() => expect(queries.at(-1)?.get('offset')).toBe('50'))

    await user.click(screen.getByRole('button', { name: 'Undo import' }))
    const dialog = await screen.findByRole('dialog', { name: 'Undo import' })
    await user.click(within(dialog).getByRole('button', { name: 'Undo' }))
    expect(await screen.findByText(/The import was undone on/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo import' })).not.toBeInTheDocument()
    // Undone, the created variant is gone: no link.
    expect(screen.queryByRole('link', { name: 'GW-1 Black' })).not.toBeInTheDocument()
  })

  it('lists what changed since when the undo conflicts, with links', async () => {
    lookups()
    runHandlers(() => applied())
    server.use(
      http.get(`/api/imports/${id(1)}/changes`, () => HttpResponse.json({ items: [], total: 0 })),
      http.post(`/api/imports/${id(1)}/undo`, () =>
        problem(409, {
          code: 'import.undo_conflict',
          params: {
            count: 53,
            entities: [
              { entity: 'product', id: id(501), label: 'GW-1' },
              { entity: 'variant', id: id(601), label: 'GW-1 Black', productId: id(501) },
              { entity: 'addons', id: id(602), label: 'X-1 X', productId: id(502) },
              { entity: 'category', id: gateways.id, label: 'gateways' },
            ],
          },
        }),
      ),
    )
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })
    await user.click(await screen.findByRole('button', { name: 'Undo import' }))
    const dialog = await screen.findByRole('dialog', { name: 'Undo import' })
    await user.click(within(dialog).getByRole('button', { name: 'Undo' }))

    expect(await within(dialog).findByText('The import cannot be undone: items it changed were changed since (53).')).toBeInTheDocument()
    const list = within(dialog).getByRole('list', { name: 'Changed since the import' })
    expect(within(list).getByRole('link', { name: 'GW-1' })).toHaveAttribute('href', `/catalog/products/${id(501)}`)
    expect(within(list).getByRole('link', { name: 'GW-1 Black' })).toHaveAttribute('href', `/catalog/products/${id(501)}/variants/${id(601)}`)
    expect(within(list).getByRole('link', { name: 'X-1 X' })).toHaveAttribute('href', `/catalog/products/${id(502)}/variants/${id(602)}`)
    expect(within(list).getByRole('link', { name: 'gateways' })).toHaveAttribute('href', `/catalog/categories/${gateways.id}`)
    expect(list).toHaveTextContent('and 49 more')
  })

  it('shows why a failed apply was rolled back, above the mapping', async () => {
    lookups([])
    runHandlers(() => run({ state: 'failed', mapping, counts: counts(), error: { code: 'variant.sku_taken', params: { sku: 'GW-1' }, rows: [4, 5] } }))
    renderRoutes(routes, { route: runRoute })
    const alert = await screen.findByText(/The import failed and was rolled back/)
    expect(alert.parentElement).toHaveTextContent('(rows 4, 5)')
    expect(await screen.findByRole('button', { name: 'Preview' })).toBeInTheDocument()
  })
})
