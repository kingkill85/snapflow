import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Proposal } from '@/api/generated/model'
import { bom, bomEur, versionId } from '@/features/bom/test-fixtures'
import { problem } from '@/features/projects/test-fixtures'
import { chooseOption } from '@/test/select'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { ProposalsTab } from './ProposalsTab'

const zigbee = bom.groups[0].productType!
const knx = { id: '00000000-0000-4000-8000-000000000112', key: 'knx', name: { en: 'KNX' }, abbreviation: 'KX', color: '#2f9e44' }
const bomTwoTypes = { ...bom, groups: [bom.groups[0], { ...bom.groups[0], productType: knx }, bom.groups[1]] }

const proposal = (over: Partial<Proposal>): Proposal => ({
  id: '00000000-0000-4000-8000-000000000c01',
  versionId,
  number: '2026-0007-V1-01',
  sequence: 1,
  exporter: 'docx',
  language: 'de',
  productType: null,
  fileName: '2026-0007-V1-01 Villa.docx',
  downloadUrl: '/api/proposals/00000000-0000-4000-8000-000000000c01/file',
  totals: bom.totals,
  createdBy: '00000000-0000-4000-8000-000000000001',
  createdByName: 'Ada Admin',
  createdAt: '2026-10-19T10:05:00Z',
  can: { delete: true },
  ...over,
})
const combined = proposal({})
const split = proposal({
  id: '00000000-0000-4000-8000-000000000c02',
  number: '2026-0007-V1-02-ZB',
  sequence: 2,
  productType: { id: zigbee.id, name: zigbee.name },
  totals: bomEur.totals,
  downloadUrl: '/api/proposals/00000000-0000-4000-8000-000000000c02/file',
  can: { delete: false },
})

const exporters = [{ key: 'docx', name: { en: 'Word document', de: 'Word-Dokument' }, fileExtension: 'docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }]

function serve(list: Proposal[] = [split, combined], bomData = bom) {
  server.use(
    http.get('/api/versions/:versionId/proposals', () => HttpResponse.json(list)),
    http.get('/api/versions/:versionId/bom', () => HttpResponse.json(bomData)),
    http.get('/api/exporters', () => HttpResponse.json(exporters)),
  )
}

// Downloads start with a click on a link; jsdom cannot navigate.
let clicked: string[] = []
beforeEach(() => {
  clicked = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this.getAttribute('href') ?? '')
  })
})
afterEach(() => vi.restoreAllMocks())

describe('ProposalsTab', () => {
  it('lists the proposals with type, language, grand total and download links', async () => {
    serve()
    renderWithProviders(<ProposalsTab versionId={versionId} canGenerate />)
    const table = await screen.findByRole('table', { name: 'Proposals' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('2026-0007-V1-02-ZB')
    expect(rows[0]).toHaveTextContent('Zigbee')
    // The grand total in the project currency, as the API computed it.
    expect(rows[0]).toHaveTextContent('€251.55')
    expect(rows[0]).toHaveTextContent('Deutsch')
    expect(rows[1]).toHaveTextContent('Combined')
    expect(rows[1]).toHaveTextContent('$279.50')
    expect(rows[1]).toHaveTextContent('Ada Admin')
    expect(within(rows[1]).getByRole('link', { name: 'Download' })).toHaveAttribute('href', combined.downloadUrl)
    // Deleting follows the API's flag.
    expect(within(rows[0]).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(within(rows[1]).getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('shows an empty state and no create button without write permission', async () => {
    serve([])
    renderWithProviders(<ProposalsTab versionId={versionId} canGenerate={false} />)
    expect(await screen.findByText('No proposals yet.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create proposal' })).not.toBeInTheDocument()
  })

  it('deletes a proposal after confirming', async () => {
    let list = [split, combined]
    serve()
    server.use(
      http.get('/api/versions/:versionId/proposals', () => HttpResponse.json(list)),
      http.delete('/api/proposals/:id', ({ params }) => {
        list = list.filter((p) => p.id !== params.id)
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<ProposalsTab versionId={versionId} canGenerate />)
    await user.click(await screen.findByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete proposal' })
    expect(dialog).toHaveTextContent('2026-0007-V1-01')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByText('2026-0007-V1-01')).not.toBeInTheDocument())
    expect(screen.getByText('2026-0007-V1-02-ZB')).toBeInTheDocument()
  })

  it('creates a combined proposal with a preview of its totals and downloads it', async () => {
    let list: Proposal[] = []
    let generated: unknown
    serve([])
    server.use(
      http.get('/api/versions/:versionId/proposals', () => HttpResponse.json(list)),
      http.post('/api/versions/:versionId/proposals/preview', () => HttpResponse.json([{ productType: null, totals: bom.totals }])),
      http.post('/api/versions/:versionId/proposals', async ({ request }) => {
        generated = await request.json()
        list = [combined]
        return HttpResponse.json([combined], { status: 201 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<ProposalsTab versionId={versionId} canGenerate />)
    await user.click(await screen.findByRole('button', { name: 'Create proposal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create proposal' })
    expect(await within(dialog).findByRole('combobox', { name: /Format/ })).toHaveTextContent('Word document (.docx)')
    expect(await within(dialog).findByTestId('preview-total')).toHaveTextContent('$279.50')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(generated).toEqual({ exporter: 'docx', split: false })
    expect(clicked).toEqual([combined.downloadUrl])
    expect(screen.getByRole('status')).toHaveTextContent('Proposal 2026-0007-V1-01 created')
    expect(await screen.findByRole('table', { name: 'Proposals' })).toHaveTextContent('2026-0007-V1-01')
  })

  it('splits per chosen product type, previews each document and requires a type', async () => {
    const previews: unknown[] = []
    let generated: unknown
    serve([], bomTwoTypes)
    server.use(
      http.post('/api/versions/:versionId/proposals/preview', async ({ request }) => {
        const body = (await request.json()) as { split: boolean; productTypeIds?: string[] }
        previews.push(body)
        if (!body.split) return HttpResponse.json([{ productType: null, totals: bom.totals }])
        return HttpResponse.json(
          (body.productTypeIds ?? []).map((id) => ({
            productType: id === knx.id ? { id: knx.id, name: knx.name } : { id: zigbee.id, name: zigbee.name },
            totals: { ...bom.totals, grandTotal: id === knx.id ? '100.00' : '179.50' },
          })),
        )
      }),
      http.post('/api/versions/:versionId/proposals', async ({ request }) => {
        generated = await request.json()
        return HttpResponse.json([split, { ...split, id: 'x', number: '2026-0007-V1-02-KX', downloadUrl: '/api/proposals/x/file' }], { status: 201 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<ProposalsTab versionId={versionId} canGenerate />)
    await user.click(await screen.findByRole('button', { name: 'Create proposal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create proposal' })
    await chooseOption(user, within(dialog).getByRole('combobox', { name: 'Documents' }), 'One document per product type')

    // Every product type of the BOM is ticked; each document gets its totals.
    const types = within(dialog).getByRole('group', { name: /Product types/ })
    expect(within(types).getByRole('checkbox', { name: /Zigbee/ })).toBeChecked()
    expect(within(types).getByRole('checkbox', { name: /KNX/ })).toBeChecked()
    await waitFor(() => expect(within(dialog).getAllByTestId('preview-total').map((e) => e.textContent)).toEqual(['$179.50', '$100.00']), { timeout: 2000 })

    // None ticked: no preview, and creating says why.
    await user.click(within(types).getByRole('checkbox', { name: /Zigbee/ }))
    await user.click(within(types).getByRole('checkbox', { name: /KNX/ }))
    expect(within(dialog).getAllByText('Choose at least one product type.')).toHaveLength(1)
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))
    // Now also at the product types, as their error.
    expect(within(dialog).getAllByText('Choose at least one product type.')).toHaveLength(2)
    expect(generated).toBeUndefined()

    await user.click(within(types).getByRole('checkbox', { name: /KNX/ }))
    await waitFor(() => expect(within(dialog).getAllByTestId('preview-total').map((e) => e.textContent)).toEqual(['$100.00']), { timeout: 2000 })
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(generated).toEqual({ exporter: 'docx', split: true, productTypeIds: [knx.id] })
    expect(clicked).toHaveLength(2)
    expect(screen.getByRole('status')).toHaveTextContent('2 proposals created')
    // Not one preview per click.
    expect(previews.length).toBeLessThan(6)
  })

  it('shows API errors of generating in the dialog', async () => {
    serve([])
    server.use(
      http.post('/api/versions/:versionId/proposals/preview', () => problem(422, { code: 'proposal.empty' })),
      http.post('/api/versions/:versionId/proposals', () => problem(422, { code: 'proposal.empty' })),
    )
    const user = userEvent.setup()
    renderWithProviders(<ProposalsTab versionId={versionId} canGenerate />)
    await user.click(await screen.findByRole('button', { name: 'Create proposal' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create proposal' })
    await within(dialog).findByRole('combobox', { name: /Format/ })
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))
    // The preview says it first; creating says it again above the fields.
    await waitFor(() => expect(within(dialog).getAllByText('The bill of materials of this version is empty; there is nothing to offer yet.')).toHaveLength(2))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(clicked).toHaveLength(0)
  })
})
