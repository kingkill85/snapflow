import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { renderRoutes } from '@/test/render'
import { server } from '@/test/server'

import { ImportRunPage } from './ImportRunPage'
import { applied, counts, id, issue, lookups, previewed, previewLists, productItem, run, runHandlers, variantItem } from './test-fixtures'

// The preview's and the result's navigation: the diff's default and search,
// issues linked to their changes, counters leading to filtered lists (and
// scrolling there), Apply blocked with its reason, and deleting a run.

const routes = [
  { path: '/catalog/imports', element: <p>runs</p> },
  { path: '/catalog/imports/:id', element: <ImportRunPage /> },
]
const runRoute = `/catalog/imports/${id(1)}`

vi.setConfig({ testTimeout: 20_000 })

const scrolled: Element[] = []
beforeEach(() => {
  scrolled.length = 0
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(this)
  })
})
afterEach(() => {
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
})

const query = (q: URLSearchParams | undefined) => Object.fromEntries(q ?? [])

describe('PreviewStep: the diff', () => {
  it('shows only changes by default, searches, and shows the changes of an issue\'s row', async () => {
    lookups()
    runHandlers(() => previewed({ counts: counts({ errors: 1, rowsSkipped: 1 }) }))
    const { itemQueries } = previewLists([productItem, variantItem], [{ ...issue, itemSeq: variantItem.seq }])
    const user = userEvent.setup()
    const { router } = renderRoutes(routes, { route: runRoute })

    await screen.findByRole('link', { name: 'GW-1 · Gateway' })
    expect(query(itemQueries[0])).toEqual({ changedOnly: 'true', limit: '50', offset: '0' })
    expect(screen.getByRole('combobox', { name: 'Change' })).toHaveTextContent('Changes only')

    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'GW-1')
    await waitFor(() => expect(query(itemQueries.at(-1))).toEqual({ changedOnly: 'true', search: 'GW-1', limit: '50', offset: '0' }))
    expect(router.state.location.search).toBe('?q=GW-1')

    // The issue's row: every item of it, its own one in view and marked.
    await user.click(screen.getByRole('link', { name: 'Changes of row 5' }))
    await waitFor(() => expect(query(itemQueries.at(-1))).toEqual({ row: '5', limit: '50', offset: '0' }))
    expect(router.state.location.hash).toBe(`#item-${variantItem.seq}`)
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('')
    expect(screen.getByRole('combobox', { name: 'Change' })).toHaveTextContent('All, also unchanged')
    const item = document.getElementById(`item-${variantItem.seq}`)!
    expect(item).toHaveClass('border-primary')
    await waitFor(() => expect(scrolled).toContain(item))
    expect(screen.getByText('Only row 5 is shown.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Show all rows' }))
    await waitFor(() => expect(query(itemQueries.at(-1))).toEqual({ limit: '50', offset: '0' }))
  })

  it('says when nothing changes and shows the unchanged items on request', async () => {
    lookups()
    runHandlers(() => previewed())
    const itemQueries: URLSearchParams[] = []
    server.use(
      http.get(`/api/imports/${id(1)}/items`, ({ request }) => {
        const q = new URL(request.url).searchParams
        itemQueries.push(q)
        const items = q.get('changedOnly') ? [] : [{ ...productItem, status: 'unchanged' as const }]
        return HttpResponse.json({ items, total: items.length })
      }),
    )
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })
    expect(await screen.findByText('Nothing changes: every item of the file is as in the catalog.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show unchanged items' }))
    expect(await screen.findByRole('link', { name: 'GW-1 · Gateway' })).toBeInTheDocument()
  })

  it('leads from the counters to the filtered lists and scrolls there', async () => {
    lookups()
    runHandlers(() =>
      previewed({ counts: counts({ errors: 1, warnings: 2, rowsSkipped: 1, addons: { new: 1, changed: 0, unchanged: 0, removed: 0, unresolved: 2 } }) }),
    )
    const { itemQueries, issueQueries } = previewLists()
    const user = userEvent.setup()
    const { router } = renderRoutes(routes, { route: runRoute })
    await screen.findByRole('link', { name: 'GW-1 · Gateway' })

    // Unresolved add-ons are warnings.
    await user.click(screen.getByRole('link', { name: 'Add-on links: Not found' }))
    await waitFor(() => expect(issueQueries.at(-1)?.get('severity')).toBe('warning'))
    await waitFor(() => expect(scrolled).toContain(document.getElementById('issues')))

    await user.click(screen.getByRole('link', { name: 'Rows: Rows with errors' }))
    await waitFor(() => expect(query(itemQueries.at(-1))).toEqual({ skipped: 'true', limit: '50', offset: '0' }))
    expect(router.state.location.hash).toBe('#changes')
    await waitFor(() => expect(scrolled).toContain(document.getElementById('changes')))

    await user.click(screen.getByRole('link', { name: 'Products: Unchanged' }))
    await waitFor(() => expect(query(itemQueries.at(-1))).toEqual({ entity: 'product', status: 'unchanged', limit: '50', offset: '0' }))
  })

  it('moves an offset past the end to the last page', async () => {
    lookups()
    runHandlers(() => previewed())
    const { itemQueries } = previewLists([productItem], [], 3)
    const { router } = renderRoutes(routes, { route: `${runRoute}?offset=100` })
    await waitFor(() => expect(itemQueries.at(-1)?.get('offset')).toBe('0'))
    expect(router.state.location.search).toBe('')
  })
})

describe('PreviewStep: apply and the run', () => {
  it('disables Apply with its reason while rows have errors and all or nothing is on; shows when it was previewed and the file', async () => {
    lookups()
    runHandlers(() => previewed({ counts: counts({ errors: 1, rowsSkipped: 1 }) }))
    previewLists()
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })

    const apply = await screen.findByRole('button', { name: 'Apply import' })
    expect(apply).toBeDisabled()
    expect(apply).toHaveAccessibleDescription('Rows have errors: with "All or nothing" nothing can be applied.')
    expect(screen.getByText(/^Previewed on .*2026.*: what the import of 3 rows changes/)).toBeInTheDocument()
    const download = screen.getByRole('link', { name: 'Download file' })
    expect(download).toHaveAttribute('href', `/api/files/${id(901)}`)
    expect(download).toHaveAttribute('download', 'supplier.xlsx')

    await user.click(screen.getByLabelText('All or nothing'))
    expect(apply).toBeEnabled()
  })

  it('edits the mapping with "All or nothing" as chosen in the preview', async () => {
    lookups([])
    runHandlers(() => previewed())
    previewLists()
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })
    await user.click(await screen.findByLabelText('All or nothing'))
    await user.click(screen.getByRole('button', { name: 'Edit mapping' }))
    await screen.findByRole('combobox', { name: 'Imported as: Category' })
    expect(screen.getByLabelText('All or nothing')).not.toBeChecked()
  })

  it('deletes the run from its page after confirming', async () => {
    lookups([])
    runHandlers(() => run())
    let deleted = false
    server.use(
      http.delete(`/api/imports/${id(1)}`, () => {
        deleted = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const user = userEvent.setup()
    const { router } = renderRoutes(routes, { route: runRoute })
    await user.click(await screen.findByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete import' })
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/catalog/imports'))
    expect(deleted).toBe(true)
  })

  it('offers no delete for an applied run', async () => {
    lookups()
    runHandlers(() => applied())
    server.use(http.get(`/api/imports/${id(1)}/changes`, () => HttpResponse.json({ items: [], total: 0 })))
    renderRoutes(routes, { route: runRoute })
    expect(await screen.findByText(/The import was applied on/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })
})

describe('ResultStep: issues', () => {
  it('lists the errors and warnings of the applied run; its counters lead there', async () => {
    lookups()
    runHandlers(() => applied({ applied: counts({ errors: 1, warnings: 2, rowsSkipped: 1 }) }))
    const { issueQueries } = previewLists([], [issue])
    server.use(http.get(`/api/imports/${id(1)}/changes`, () => HttpResponse.json({ items: [], total: 0 })))
    const user = userEvent.setup()
    renderRoutes(routes, { route: runRoute })

    const table = await screen.findByRole('table', { name: 'Errors and warnings' })
    expect(within(table).getByRole('row', { name: /appears more than once/ })).toHaveTextContent('5')
    // No diff on this step: the row is no link.
    expect(within(table).queryByRole('link')).not.toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: 'Rows: Warnings' }))
    await waitFor(() => expect(issueQueries.at(-1)?.get('severity')).toBe('warning'))
  })
})
