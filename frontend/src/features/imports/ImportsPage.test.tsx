import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { renderRoutes } from '@/test/render'
import { server } from '@/test/server'

import { ImportsPage } from './ImportsPage'
import { NewImportPage } from './NewImportPage'
import { applied, counts, id, lookups, previewed, problem, profile, run } from './test-fixtures'

const routes = [
  { path: '/catalog/imports', element: <ImportsPage /> },
  { path: '/catalog/imports/new', element: <NewImportPage /> },
  { path: '/catalog/imports/:id', element: <p>run page</p> },
]

describe('ImportsPage', () => {
  it('lists runs newest first with state, profile, user, result and dates; pages', async () => {
    const queries: URLSearchParams[] = []
    server.use(
      http.get('/api/imports', ({ request }) => {
        queries.push(new URL(request.url).searchParams)
        return HttpResponse.json({
          items: [
            applied({ id: id(3), fileName: 'b.xlsx', profileName: 'Supplier A', applied: counts({ errors: 2 }) }),
            previewed({ id: id(2), fileName: 'a.csv', counts: counts({ products: { new: 0, changed: 0, unchanged: 3, deactivate: 0 } }) }),
            run({ id: id(1), fileName: '' }),
          ],
          total: 60,
        })
      }),
    )
    const user = userEvent.setup()
    renderRoutes(routes, { route: '/catalog/imports' })

    const first = (await screen.findByRole('link', { name: 'b.xlsx' })).closest('tr')!
    expect(within(first).getByText('Applied')).toBeInTheDocument()
    expect(first).toHaveTextContent('Supplier A')
    expect(first).toHaveTextContent('Products: 2 new, 1 changed, 1 deactivated')
    expect(first).toHaveTextContent('Variants: 3 new')
    expect(first).toHaveTextContent('2 errors')
    expect(first).toHaveTextContent('Ada Admin')
    expect(first).toHaveTextContent(/Applied .*2026/)
    const second = screen.getByRole('link', { name: 'a.csv' }).closest('tr')!
    expect(second).toHaveTextContent('Products: no changes')
    expect(second).toHaveTextContent('Own mapping')
    expect(screen.getByRole('link', { name: '(no file name)' }).closest('tr')).toHaveTextContent('Not previewed yet')
    expect(screen.getByRole('link', { name: 'b.xlsx' })).toHaveAttribute('href', `/catalog/imports/${id(3)}`)

    expect(screen.getByText('1–50 of 60')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Next/ }))
    await waitFor(() => expect(queries.at(-1)?.get('offset')).toBe('50'))
  })

  it('deletes a run after confirming; an applied one offers no delete, and one applied meanwhile says to undo it first', async () => {
    let items = [applied({ id: id(3), fileName: 'b.xlsx' }), previewed({ id: id(2), fileName: 'a.csv' }), run({ id: id(1), fileName: 'c.csv' })]
    const deleted: string[] = []
    server.use(
      http.get('/api/imports', () => HttpResponse.json({ items, total: items.length })),
      http.delete('/api/imports/:id', ({ params }) => {
        if (params.id === id(1)) return problem(409, { code: 'import.state', params: { state: 'applied' } })
        deleted.push(String(params.id))
        items = items.filter((r) => r.id !== params.id)
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const user = userEvent.setup()
    renderRoutes(routes, { route: '/catalog/imports' })

    const appliedRow = (await screen.findByRole('link', { name: 'b.xlsx' })).closest('tr')!
    expect(within(appliedRow).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()

    await user.click(within(screen.getByRole('link', { name: 'a.csv' }).closest('tr')!).getByRole('button', { name: 'Delete' }))
    let dialog = await screen.findByRole('dialog', { name: 'Delete import' })
    expect(dialog).toHaveTextContent('Delete the import of "a.csv"?')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('link', { name: 'a.csv' })).not.toBeInTheDocument())
    expect(deleted).toEqual([id(2)])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(within(screen.getByRole('link', { name: 'c.csv' }).closest('tr')!).getByRole('button', { name: 'Delete' }))
    dialog = await screen.findByRole('dialog', { name: 'Delete import' })
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(await within(dialog).findByText('This import is applied: undo it first, then delete it.')).toBeInTheDocument()
  })

  it('offers a new import when there is none', async () => {
    server.use(http.get('/api/imports', () => HttpResponse.json({ items: [], total: 0 })))
    renderRoutes(routes, { route: '/catalog/imports' })
    expect(await screen.findByText('No imports yet.')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'New import' })[0]).toHaveAttribute('href', '/catalog/imports/new')
  })
})

describe('NewImportPage', () => {
  const xlsx = (name = 'supplier.xlsx', size = 10) => new File([new Uint8Array(size)], name)

  it('checks the file type and size before uploading', async () => {
    lookups()
    let uploads = 0
    server.use(http.post('/api/imports', () => (uploads++, HttpResponse.json(run(), { status: 201 }))))
    const user = userEvent.setup({ applyAccept: false })
    renderRoutes(routes, { route: '/catalog/imports/new' })

    await user.click(await screen.findByRole('button', { name: 'Upload and map columns' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('required')

    await user.upload(screen.getByLabelText('File to import'), xlsx('old.xls'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Only .xlsx workbooks and UTF-8 .csv files can be imported.')
    expect(screen.getByText('old.xls')).toBeInTheDocument()

    const big = xlsx('big.xlsx')
    Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 })
    await user.upload(screen.getByLabelText('File to import'), big)
    expect(await screen.findByRole('alert')).toHaveTextContent('The file is too large (at most 50 MB).')
    await user.click(screen.getByRole('button', { name: 'Upload and map columns' }))
    expect(uploads).toBe(0)
  })

  it('uploads the file and opens the run; a profile previews at once there', async () => {
    lookups([profile()])
    let body: FormData | undefined
    server.use(
      http.post('/api/imports', async ({ request }) => {
        body = await request.formData()
        return HttpResponse.json(run({ id: id(7) }), { status: 201 })
      }),
    )
    const user = userEvent.setup()
    const { router } = renderRoutes(routes, { route: '/catalog/imports/new' })

    await user.upload(await screen.findByLabelText('File to import'), xlsx())
    expect(screen.getByText('supplier.xlsx')).toBeInTheDocument()
    await user.click(screen.getByRole('combobox', { name: 'Saved mapping' }))
    await user.click(await screen.findByRole('option', { name: 'Supplier A' }))
    await user.click(screen.getByRole('button', { name: 'Upload and preview' }))

    expect(await screen.findByText('run page')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(`/catalog/imports/${id(7)}`)
    // The profile stays in the URL until the run page's preview with it settled.
    expect(router.state.location.search).toBe(`?profile=${profile().id}`)
    // The profile is not sent with the file: the run page previews, so a failing preview shows at the mapping.
    expect((body!.get('file') as File).name).toBe('supplier.xlsx')
    expect(body?.get('profileId')).toBeNull()
  })

  it('aborts a running upload when the page is left', async () => {
    lookups()
    let signal: AbortSignal | undefined
    server.use(
      http.get('/api/imports', () => HttpResponse.json({ items: [], total: 0 })),
      http.post('/api/imports', ({ request }) => {
        signal = request.signal
        return new Promise<Response>(() => {})
      }),
    )
    const user = userEvent.setup()
    const { router } = renderRoutes(routes, { route: '/catalog/imports/new' })
    await user.upload(await screen.findByLabelText('File to import'), xlsx())
    await user.click(screen.getByRole('button', { name: 'Upload and map columns' }))
    expect(await screen.findByRole('progressbar', { name: 'Uploading…' })).toBeInTheDocument()
    await waitFor(() => expect(signal).toBeDefined())

    await user.click(screen.getByRole('link', { name: 'Cancel' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/catalog/imports'))
    await waitFor(() => expect(signal?.aborted).toBe(true))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the server refusing the file at the file', async () => {
    lookups()
    server.use(http.post('/api/imports', () => problem(422, { code: 'import.too_many_rows', params: { max: 20000 } })))
    const user = userEvent.setup()
    renderRoutes(routes, { route: '/catalog/imports/new' })
    await user.upload(await screen.findByLabelText('File to import'), xlsx())
    await user.click(screen.getByRole('button', { name: 'Upload and map columns' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The sheet has too many rows (at most 20,000).')
  })
})
