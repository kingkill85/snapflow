import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { Networks } from '@/api/generated/model'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { NetworksTab } from './NetworksTab'
import { emptyNetworks, firstFloor, gatewayFirst, knx, lineOne, lineTwo, networks, readOnlyNetworks, versionId } from './test-fixtures'

function serve(data: Networks) {
  server.use(http.get('/api/versions/:versionId/networks', () => HttpResponse.json(data)))
}

/** Records the bodies of PUT …/network-assignments. */
function captureAssignments() {
  const bodies: unknown[] = []
  server.use(
    http.put('/api/versions/:versionId/network-assignments', async ({ request }) => {
      bodies.push(await request.json())
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return bodies
}

const rows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1)

describe('NetworksTab', () => {
  it('shows bus lines with totals and members, and gateways with their devices', async () => {
    serve(networks)
    renderWithProviders(<NetworksTab versionId={versionId} />)

    const bus = await screen.findByRole('region', { name: 'KNX' })
    expect(within(bus).getByRole('heading', { name: 'KNX 1' })).toBeInTheDocument()
    expect(within(bus).getByText('Address 1.1')).toBeInTheDocument()
    expect(within(bus).getByText('2 devices · used 12 mA / supplied 640 mA')).toBeInTheDocument()
    expect(within(bus).getByText(/1 without known current/)).toBeInTheDocument()

    const one = within(bus).getByRole('table', { name: 'KNX 1' })
    const [supplyRow, actuatorRow] = rows(one)
    expect(supplyRow).toHaveTextContent('Power supply')
    expect(supplyRow).toHaveTextContent('supplies 640 mA')
    expect(supplyRow).toHaveTextContent('Default')
    expect(actuatorRow).toHaveTextContent('Switch actuator 8-fold')
    expect(actuatorRow).toHaveTextContent('Kitchen')
    expect(actuatorRow).toHaveTextContent('12 mA')
    const two = within(bus).getByRole('table', { name: 'KNX 2' })
    expect(rows(two)[0]).toHaveTextContent('Pinned')
    expect(rows(two)[0]).toHaveTextContent('Unknown')

    const wireless = screen.getByRole('region', { name: 'Zigbee' })
    expect(within(wireless).getByRole('heading', { name: 'Zigbee gateway, Ground floor' })).toBeInTheDocument()
    expect(within(wireless).getByText('1 of 50 places used')).toBeInTheDocument()
    expect(within(wireless).getByText(/1 without known places/)).toBeInTheDocument()
    expect(within(wireless).getByRole('table', { name: 'Zigbee gateway, Ground floor' })).toHaveTextContent('Front door')
    expect(within(wireless).getByText('Without gateway')).toBeInTheDocument()
    expect(within(wireless).getByRole('table', { name: 'Zigbee: Without gateway' })).toHaveTextContent('Leak sensor')
  })

  it('moves a bus member to another line', async () => {
    const user = userEvent.setup()
    serve(networks)
    const bodies = captureAssignments()
    renderWithProviders(<NetworksTab versionId={versionId} />)

    await user.click(await screen.findByRole('combobox', { name: 'Line of Switch actuator 8-fold · Kitchen, Ground floor' }))
    await user.click(screen.getByRole('option', { name: 'KNX 2' }))

    await waitFor(() => expect(bodies).toEqual([{ assignments: [{ planId: lineOne.members[1].planId, itemId: lineOne.members[1].itemId, busLineId: lineTwo.id }] }]))
  })

  it('resets a pinned member and a pinned device to the default', async () => {
    const user = userEvent.setup()
    serve(networks)
    const bodies = captureAssignments()
    renderWithProviders(<NetworksTab versionId={versionId} />)

    const two = await screen.findByRole('table', { name: 'KNX 2' })
    await user.click(within(rows(two)[0]).getByRole('button', { name: 'Reset to default' }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    const gateway = screen.getByRole('table', { name: 'Zigbee gateway, First floor' })
    await user.click(within(rows(gateway)[0]).getByRole('button', { name: 'Reset to default' }))
    await waitFor(() => expect(bodies).toHaveLength(2))

    expect(bodies).toEqual([
      { assignments: [{ planId: firstFloor, itemId: lineTwo.members[0].itemId }] },
      { assignments: [{ planId: firstFloor, itemId: gatewayFirst.devices[0].itemId }] },
    ])
    // Members that follow the default have nothing to reset.
    expect(within(screen.getByRole('table', { name: 'KNX 1' })).queryByRole('button', { name: 'Reset to default' })).not.toBeInTheDocument()
  })

  it('reassigns a wireless device to another gateway', async () => {
    const user = userEvent.setup()
    serve(networks)
    const bodies = captureAssignments()
    renderWithProviders(<NetworksTab versionId={versionId} />)

    await user.click(await screen.findByRole('combobox', { name: 'Gateway of Door sensor · Front door, Ground floor' }))
    await user.click(screen.getByRole('option', { name: 'Zigbee gateway, First floor' }))

    await waitFor(() =>
      expect(bodies).toEqual([
        { assignments: [{ planId: networks.wirelessSystems[0].gateways[0].devices[0].planId, itemId: networks.wirelessSystems[0].gateways[0].devices[0].itemId, gatewayPlanId: firstFloor, gatewayItemId: gatewayFirst.itemId }] },
      ]),
    )
  })

  it('adds a line, reorders lines and blocks deleting a line with pinned members', async () => {
    const user = userEvent.setup()
    serve(networks)
    const created: unknown[] = []
    const orders: unknown[] = []
    server.use(
      http.post('/api/versions/:versionId/bus-lines', async ({ request }) => {
        created.push(await request.json())
        return HttpResponse.json({ ...lineTwo, id: 'new', name: 'KNX 3', position: 3 }, { status: 201 })
      }),
      http.put('/api/versions/:versionId/bus-lines/order', async ({ request }) => {
        orders.push(await request.json())
        return new HttpResponse(null, { status: 204 })
      }),
    )
    renderWithProviders(<NetworksTab versionId={versionId} />)

    await user.click(await screen.findByRole('button', { name: 'Add line' }))
    const dialog = await screen.findByRole('dialog', { name: 'New line' })
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'KNX 3')
    await user.type(within(dialog).getByRole('textbox', { name: 'Address' }), '1.3')
    const max = within(dialog).getByRole('textbox', { name: 'Max. devices' })
    await user.type(max, '0')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(await within(dialog).findByText(/Enter a value between 1 and 10[,.]?000/)).toBeInTheDocument()
    await user.clear(max)
    await user.type(max, '32')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(created).toEqual([{ productTypeId: knx.id, name: 'KNX 3', address: '1.3', devicesMax: 32 }]))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    expect(screen.getByRole('button', { name: 'Move KNX 1 up' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Move KNX 1 down' }))
    await waitFor(() => expect(orders).toEqual([{ ids: [lineTwo.id, lineOne.id] }]))

    expect(screen.getByRole('button', { name: 'Delete KNX 2' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete KNX 1' })).toBeEnabled()
  })

  it('shows readers the networks without controls and members without a line', async () => {
    serve(readOnlyNetworks)
    renderWithProviders(<NetworksTab versionId={versionId} />)

    const bus = await screen.findByRole('region', { name: 'KNX' })
    expect(within(bus).getByText('Without line')).toBeInTheDocument()
    expect(within(bus).getByRole('table', { name: 'KNX: Without line' })).toHaveTextContent('Kitchen')
    expect(screen.getByText('Read only: assignments cannot be changed here.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add line' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset to default' })).not.toBeInTheDocument()
  })

  it('shows the empty state without systems', async () => {
    serve(emptyNetworks)
    renderWithProviders(<NetworksTab versionId={versionId} />)
    expect(await screen.findByText('No bus or wireless devices on the plans of this version yet.')).toBeInTheDocument()
  })
})
