import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AddressedItem, Addresses, GeneratedDocument } from '@/api/generated/model'
import { problem } from '@/features/projects/test-fixtures'
import i18n from '@/i18n'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { InstallationDocumentsSection } from './InstallationDocumentsSection'
import { ProgrammingExportsSection } from './ProgrammingExportsSection'

const versionId = '00000000-0000-4000-8000-0000000000a1'

const doc = (over: Partial<GeneratedDocument>): GeneratedDocument => ({
  id: '00000000-0000-4000-8000-000000000d01',
  versionId,
  kind: 'installation_manual',
  number: '2026-0007-V1-IM01',
  sequence: 1,
  exporter: 'docx',
  language: 'de',
  fileName: '2026-0007-V1-IM01 Villa.docx',
  downloadUrl: '/api/documents/00000000-0000-4000-8000-000000000d01/file',
  createdBy: '00000000-0000-4000-8000-000000000001',
  createdByName: 'Ada Admin',
  createdAt: '2026-10-19T10:05:00Z',
  can: { delete: true },
  ...over,
})
const manual = doc({})
const labels = doc({
  id: '00000000-0000-4000-8000-000000000d02',
  kind: 'channel_labels',
  number: '2026-0007-V1-LB01',
  fileName: '2026-0007-V1-LB01 Villa.docx',
  downloadUrl: '/api/documents/00000000-0000-4000-8000-000000000d02/file',
  createdByName: undefined,
  can: { delete: false },
})

const item = (scheme: AddressedItem['scheme'], n: number): AddressedItem => ({
  planId: '00000000-0000-4000-8000-0000000000b1',
  planKind: 'board',
  planName: 'Main board',
  itemId: `00000000-0000-4000-8000-00000000010${n}`,
  label: '',
  productName: { en: 'Device' },
  variantName: { en: '' },
  modelNumber: 'M-1',
  variantId: '00000000-0000-4000-8000-0000000000c1',
  systemId: '00000000-0000-4000-8000-0000000000c2',
  existing: false,
  gateway: false,
  powerSupply: false,
  scheme,
})
const addresses = (items: AddressedItem[]): Addresses => ({ versionId, items, lines: [], can: { update: true } })

let clicked: string[] = []
beforeEach(() => {
  clicked = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this.getAttribute('href') ?? '')
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await i18n.changeLanguage('en')
})

describe('InstallationDocumentsSection', () => {
  it('lists the documents with kind, language, creator and download links', async () => {
    server.use(http.get('/api/versions/:versionId/documents', () => HttpResponse.json([labels, manual])))
    renderWithProviders(<InstallationDocumentsSection versionId={versionId} canGenerate />)
    const table = await screen.findByRole('table', { name: 'Installation documents' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('2026-0007-V1-LB01')
    expect(rows[0]).toHaveTextContent('Channel labels')
    expect(rows[0]).toHaveTextContent('German')
    expect(rows[0]).toHaveTextContent('Deleted user')
    expect(rows[1]).toHaveTextContent('Installation manual')
    expect(rows[1]).toHaveTextContent('Ada Admin')
    expect(within(rows[1]).getByRole('link', { name: 'Download' })).toHaveAttribute('href', manual.downloadUrl)
    expect(within(rows[0]).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(within(rows[1]).getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('generates the manual and the labels, downloads and lists them', async () => {
    let list: GeneratedDocument[] = []
    const bodies: unknown[] = []
    server.use(
      http.get('/api/versions/:versionId/documents', () => HttpResponse.json(list)),
      http.post('/api/versions/:versionId/documents', async ({ request }) => {
        const body = (await request.json()) as { kind: string }
        bodies.push(body)
        const created = body.kind === 'channel_labels' ? labels : manual
        list = [created, ...list]
        return HttpResponse.json(created, { status: 201 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<InstallationDocumentsSection versionId={versionId} canGenerate />)
    expect(await screen.findByText(/No installation documents yet. Generate/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Installation manual (DOCX)' }))
    expect(await screen.findByText(/2026-0007-V1-IM01 created/)).toBeInTheDocument()
    expect(clicked).toEqual([manual.downloadUrl])
    await user.click(screen.getByRole('button', { name: 'Channel labels (DOCX)' }))
    expect(await screen.findByText(/2026-0007-V1-LB01 created/)).toBeInTheDocument()
    expect(bodies).toEqual([{ kind: 'installation_manual' }, { kind: 'channel_labels' }])
    const table = await screen.findByRole('table', { name: 'Installation documents' })
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3))
  })

  it('shows a generation error', async () => {
    server.use(
      http.get('/api/versions/:versionId/documents', () => HttpResponse.json([])),
      http.post('/api/versions/:versionId/documents', () => problem(409, { code: 'project.read_only', detail: 'read only' })),
    )
    const user = userEvent.setup()
    renderWithProviders(<InstallationDocumentsSection versionId={versionId} canGenerate />)
    await user.click(await screen.findByRole('button', { name: 'Installation manual (DOCX)' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(clicked).toEqual([])
  })

  it('deletes a document after confirming', async () => {
    let list = [manual]
    server.use(
      http.get('/api/versions/:versionId/documents', () => HttpResponse.json(list)),
      http.delete('/api/documents/:id', ({ params }) => {
        list = list.filter((d) => d.id !== params.id)
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<InstallationDocumentsSection versionId={versionId} canGenerate />)
    const table = await screen.findByRole('table', { name: 'Installation documents' })
    await user.click(within(table).getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete document' })
    expect(dialog).toHaveTextContent('2026-0007-V1-IM01')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText(/No installation documents yet. Generate/)).toBeInTheDocument()
  })

  it('has no generate buttons without write permission', async () => {
    server.use(http.get('/api/versions/:versionId/documents', () => HttpResponse.json([])))
    renderWithProviders(<InstallationDocumentsSection versionId={versionId} canGenerate={false} />)
    expect(await screen.findByText('No installation documents yet.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Installation manual (DOCX)' })).not.toBeInTheDocument()
  })
})

describe('ProgrammingExportsSection', () => {
  it('offers the exports of the systems the version has and disables the others with the reason', async () => {
    server.use(http.get('/api/versions/:versionId/addresses', () => HttpResponse.json(addresses([item('knx', 1), item('none', 2)]))))
    renderWithProviders(<ProgrammingExportsSection versionId={versionId} />)
    expect(await screen.findByRole('button', { name: 'Download: KNX group addresses (CSV)' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Download: KNX device list (XLSX)' })).toBeEnabled()
    const hdl = screen.getByRole('button', { name: 'Download: HDL commissioning list (XLSX)' })
    expect(hdl).toBeDisabled()
    expect(hdl).toHaveAccessibleDescription('This version has no HDL devices.')
    const wireless = screen.getByRole('button', { name: 'Download: Wireless device list (EUI-64) (XLSX)' })
    expect(wireless).toBeDisabled()
    expect(wireless).toHaveAccessibleDescription('This version has no wireless devices.')
  })

  it('fetches an export as a file and saves it under the name the API sends', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:wireless')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const names: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.getAttribute('href') ?? '')
      names.push(this.download)
    })
    server.use(
      http.get('/api/versions/:versionId/addresses', () => HttpResponse.json(addresses([item('hdl', 1), item('ieee', 2)]))),
      http.get(
        '/api/versions/:versionId/exports/wireless-devices.xlsx',
        () =>
          new HttpResponse('xlsx', {
            headers: { 'Content-Disposition': `attachment; filename="V1 Wireless.xlsx"; filename*=UTF-8''V1%20Funk-Ger%C3%A4te.xlsx` },
          }),
      ),
    )
    const user = userEvent.setup()
    renderWithProviders(<ProgrammingExportsSection versionId={versionId} />)
    await user.click(await screen.findByRole('button', { name: 'Download: Wireless device list (EUI-64) (XLSX)' }))
    await waitFor(() => expect(clicked).toEqual(['blob:wireless']))
    expect(names).toEqual(['V1 Funk-Geräte.xlsx'])
    expect(screen.getByRole('button', { name: 'Download: KNX group addresses (CSV)' })).toBeDisabled()
  })

  it('shows the translated API error of a failed export', async () => {
    server.use(
      http.get('/api/versions/:versionId/addresses', () => HttpResponse.json(addresses([item('knx', 1)]))),
      http.get('/api/versions/:versionId/exports/knx-group-addresses.csv', () =>
        problem(422, { code: 'export.too_many_group_addresses', detail: 'too many', params: { max: 31 } }),
      ),
    )
    const user = userEvent.setup()
    renderWithProviders(<ProgrammingExportsSection versionId={versionId} />)
    await user.click(await screen.findByRole('button', { name: 'Download: KNX group addresses (CSV)' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many floors, zones or functions for KNX group addresses (at most 31).')
    expect(clicked).toEqual([])
  })

  it('updates the group addresses and reports the result', async () => {
    server.use(
      http.get('/api/versions/:versionId/addresses', () => HttpResponse.json(addresses([item('knx', 1)]))),
      http.post('/api/versions/:versionId/group-addresses/assign', () => HttpResponse.json({ added: 3, total: 12 })),
    )
    const user = userEvent.setup()
    renderWithProviders(<ProgrammingExportsSection versionId={versionId} />)
    await user.click(await screen.findByRole('button', { name: 'Update group addresses' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Group addresses updated: 3 new, 12 in total.')
  })

  it('has no update button on read-only versions', async () => {
    server.use(
      http.get('/api/versions/:versionId/addresses', () => HttpResponse.json({ ...addresses([item('knx', 1)]), can: { update: false } })),
    )
    renderWithProviders(<ProgrammingExportsSection versionId={versionId} />)
    expect(await screen.findByRole('button', { name: 'Download: KNX group addresses (CSV)' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Update group addresses' })).not.toBeInTheDocument()
  })
})
