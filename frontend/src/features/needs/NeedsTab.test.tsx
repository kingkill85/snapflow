import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { Rooms } from '@/api/generated/model'
import { serveChecks } from '@/features/checks/test-fixtures'
import i18n from '@/i18n'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { NeedsTab } from './NeedsTab'
import { groundId, hallId, livingId, noRooms, projectId, rooms, upperId, versionId } from './test-fixtures'

function serve(data: Rooms) {
  server.use(http.get('/api/versions/:versionId/rooms', () => HttpResponse.json(data)))
}
const render = () => renderWithProviders(<NeedsTab projectId={projectId} versionId={versionId} />)
const editor = (planId: string) => `/projects/${projectId}/versions/${versionId}/plans/${planId}`

describe('NeedsTab', () => {
  it('shows the totals of the API: needs, units, connected, power and by function', async () => {
    serve(rooms)
    render()
    expect(await screen.findByRole('heading', { name: 'Rooms' })).toBeInTheDocument()
    const totals = screen.getByRole('list', { name: 'By function' })
    expect(within(totals).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Blind: 3 of 3 connected', 'Dimmable light: 2 of 3 connected'])
    expect(screen.getByText('5 of 6', { exact: true })).toBeInTheDocument()
    expect(screen.getByText('22.5 W')).toBeInTheDocument()
  })

  it('lists every zone with chips, counts and status, the needs outside every zone last', async () => {
    serve(rooms)
    render()
    const ground = await screen.findByRole('list', { name: 'Ground floor' })
    const rows = within(ground).getAllByRole('listitem', { name: /./ })
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual(['Living room', 'Hall', 'Outside every zone'])

    const living = rows[0]
    expect(within(living).getByText('LR')).toBeInTheDocument()
    expect(within(living).getByText('3 of 4 connected')).toBeInTheDocument()
    expect(within(living).getByText('Some missing')).toBeInTheDocument()
    const chips = within(within(living).getByRole('list', { name: 'Needs of Living room' })).getAllByRole('listitem')
    expect(chips[0]).toHaveTextContent('3 × Dimmable light · 7.5 W · Ceiling')
    expect(chips[1]).toHaveTextContent('1 × Blind')
    expect(within(living).getByRole('link', { name: 'Open Living room in the editor' })).toHaveAttribute('href', `${editor(groundId)}?select=${livingId}`)
    expect(within(living).getByRole('button', { name: 'Connect Living room automatically' })).toBeInTheDocument()

    const hall = rows[1]
    expect(within(hall).getByText('No needs yet')).toBeInTheDocument()
    expect(within(hall).getByRole('link', { name: 'Apply a room template to Hall' })).toHaveAttribute('href', `${editor(groundId)}?select=${hallId}&focus=template`)
    expect(within(hall).queryByRole('button', { name: /automatically/ })).not.toBeInTheDocument()

    const outside = rows[2]
    expect(within(outside).getByText('All connected')).toBeInTheDocument()
    expect(within(outside).queryByRole('link', { name: /room template/ })).not.toBeInTheDocument()

    const upper = screen.getByRole('region', { name: 'Upper floor' })
    expect(within(upper).getByText('This floorplan has no zones yet.')).toBeInTheDocument()
    expect(within(upper).getByRole('link', { name: 'Open in editor' })).toHaveAttribute('href', editor(upperId))
  })

  it('connects one zone automatically through the existing dialog, scoped to that zone', async () => {
    serve(rooms)
    serveChecks()
    let body: unknown = null
    server.use(
      http.post('/api/versions/:versionId/auto-connect/preview', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ connections: [], unconnectable: [], needs: 1, units: 1, connectedUnits: 1, checksum: 'c' })
      }),
      http.post('/api/versions/:versionId/auto-connect/apply', () => HttpResponse.json({ batchId: null, connections: [] })),
    )
    render()
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Living room automatically' }))
    const dialog = await screen.findByRole('dialog', { name: 'Auto-connect' })
    expect(within(dialog).getByRole('checkbox', { name: /Living room/ })).toBeChecked()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Preview' }))
    await within(dialog).findByText('1 unit will be connected.')
    expect(body).toEqual({ scope: 'zones', zoneIds: [livingId] })
  })

  it('hides the write actions on a read-only version', async () => {
    serve({ ...rooms, can: { update: false } })
    render()
    await screen.findByRole('list', { name: 'Ground floor' })
    expect(screen.queryByRole('link', { name: /room template/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /automatically/ })).not.toBeInTheDocument()
  })

  it('writes German texts and decimals with a comma', async () => {
    await i18n.changeLanguage('de')
    try {
      serve(rooms)
      render()
      expect(await screen.findByRole('heading', { name: 'Räume' })).toBeInTheDocument()
      expect(screen.getByText('3 × Dimmbares Licht · 7,5 W · Ceiling')).toBeInTheDocument()
      expect(screen.getByText('Außerhalb aller Zonen')).toBeInTheDocument()
      expect(screen.getByText('Teilweise offen')).toBeInTheDocument()
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('shows the empty state without floorplans', async () => {
    serve(noRooms)
    render()
    expect(await screen.findByText('No floorplans yet: add a floorplan on the Plans tab, draw its zones and add their needs.')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('list')).not.toBeInTheDocument())
  })
})
