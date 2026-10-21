import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { Addresses, Checks, Networks } from '@/api/generated/model'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { NetworksTab } from './NetworksTab'
import { actuator, addresses, doorSensor, emptyNetworks, firstFloor, gatewayFirst, gatewayGround, knx, lineOne, lineTwo, networks, readOnlyNetworks, versionId } from './test-fixtures'

const noChecks: Checks = {
  versionId,
  counts: { errors: 0, warnings: 0, infos: 0, units: 0, connectedUnits: 0, zonesWithNeeds: 0, zonesCovered: 0 },
  zones: [],
  boards: [],
  busLines: [],
  gateways: [],
  findings: [],
}

function serve(data: Networks, checks: Checks = noChecks, addr: Addresses = { ...addresses, can: { update: data.can.update } }) {
  server.use(
    http.get('/api/versions/:versionId/addresses', () => HttpResponse.json(addr)),
    http.get('/api/versions/:versionId/networks', () => HttpResponse.json(data)),
    http.get('/api/versions/:versionId/checks', () => HttpResponse.json(checks)),
  )
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
    renderWithProviders(<NetworksTab projectId="p1" versionId={versionId} />)

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
    expect(within(bus).getByText(/^1 of max. 32 devices · /)).toBeInTheDocument()
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
    renderWithProviders(<NetworksTab projectId="p1" versionId={versionId} />)

    await user.click(await screen.findByRole('combobox', { name: 'Line of Switch actuator 8-fold · Kitchen, Ground floor' }))
    await user.click(screen.getByRole('option', { name: 'KNX 2' }))

    await waitFor(() => expect(bodies).toEqual([{ assignments: [{ planId: lineOne.members[1].planId, itemId: lineOne.members[1].itemId, busLineId: lineTwo.id }] }]))
  })

  it('resets a pinned member and a pinned device to the default', async () => {
    const user = userEvent.setup()
    serve(networks)
    const bodies = captureAssignments()
    renderWithProviders(<NetworksTab projectId="p1" versionId={versionId} />)

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
    renderWithProviders(<NetworksTab projectId="p1" versionId={versionId} />)

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
    renderWithProviders(<NetworksTab projectId="p1" versionId={versionId} />)

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
    renderWithProviders(<NetworksTab projectId="p1" versionId={versionId} />)

    const bus = await screen.findByRole('region', { name: 'KNX' })
    expect(within(bus).getByText('Without line')).toBeInTheDocument()
    expect(within(bus).getByRole('table', { name: 'KNX: Without line' })).toHaveTextContent('Kitchen')
    expect(screen.getByText('Read only: assignments cannot be changed here.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add line' })).not.toBeInTheDocument()
    expect(screen.getByText('These devices need a bus line.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create line' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset to default' })).not.toBeInTheDocument()
  })

  it('asks for a bus line when bus devices have none, with "Create line" only for writers', async () => {
    const user = userEvent.setup()
    serve({ ...readOnlyNetworks, can: { update: true } })
    renderWithProviders(<NetworksTab projectId="p1" versionId={versionId} />)
    expect(await screen.findByText('These devices need a bus line.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create line' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('shows the empty state without systems', async () => {
    serve(emptyNetworks)
    renderWithProviders(<NetworksTab projectId="p1" versionId={versionId} />)
    expect(await screen.findByText(/^No bus or wireless devices on the plans of this version yet\. Place products of a bus or wireless system/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to the plans' })).toHaveAttribute('href', `/projects/p1/versions/${versionId}`)
  })

  it('shows the reserve statuses of lines and gateways from the checks and scrolls to a linked line', async () => {
    serve(networks, {
      ...noChecks,
      busLines: [
        { busLineId: lineOne.id, name: 'KNX 1', productTypeId: knx.id, reservePercent: 20, currentUsedMa: 612, currentDefaultMa: 0, currentSuppliedMa: 640, unknownCurrentCount: 0, currentStatus: 'amber', devices: 2, devicesStatus: 'unknown' },
      ],
      gateways: [
        { planId: gatewayGround.planId, itemId: gatewayGround.itemId, label: '', productName: null, productTypeId: knx.id, reservePercent: 10, placesUsed: 1, placesSupplied: 50, unknownCount: 0, devices: 1, routers: 0, status: 'ok' },
      ],
    })
    const scrolled: string[] = []
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id)
    }
    renderWithProviders(<NetworksTab projectId="p1" versionId={versionId} />, { route: `/?tab=networks#line-${lineOne.id}` })

    const line = await screen.findByTestId(`bus-line-${lineOne.id}`)
    expect(line).toHaveAttribute('id', `line-${lineOne.id}`)
    expect(await within(line).findByText('Near limit')).toBeInTheDocument()
    expect(within(line).getByText('Unknown')).toBeInTheDocument()
    expect(within(line).getByText('reserve 20 %')).toBeInTheDocument()
    expect(within(screen.getByTestId(`bus-line-${lineTwo.id}`)).queryByText('Near limit')).not.toBeInTheDocument()
    const gateway = document.getElementById(`gateway-${gatewayGround.itemId}`)!
    expect(within(gateway).getByText('OK')).toBeInTheDocument()
    expect(within(gateway).getByText('reserve 10 %')).toBeInTheDocument()
    await waitFor(() => expect(scrolled).toContain(`line-${lineOne.id}`))
  })

  describe('addresses', () => {
    it('shows addresses with by-hand and automatic markers and line prefixes', async () => {
      serve(networks)
      renderWithProviders(<NetworksTab projectId="p1" versionId={versionId} />)
      const bus = await screen.findByRole('region', { name: 'KNX' })
      const [supplyRow, actuatorRow] = rows(within(bus).getByRole('table', { name: 'KNX 1' }))
      expect(await within(actuatorRow).findByText('1.1.1')).toBeInTheDocument()
      expect(actuatorRow).toHaveTextContent('Automatic')
      expect(within(supplyRow).queryByRole('button', { name: /Edit address/ })).not.toBeInTheDocument()
      expect(rows(within(bus).getByRole('table', { name: 'KNX 2' }))[0]).toHaveTextContent('1.2.7By hand')
      expect(within(bus).getByText('Device addresses 1.1.x')).toBeInTheDocument()
      expect(within(bus).getByText('Device addresses 1.2.x (default, no line address entered)')).toBeInTheDocument()
      const wireless = screen.getByRole('region', { name: 'Zigbee' })
      expect(within(wireless).getByText('00124B001CA1B2C3')).toBeInTheDocument()
      expect(document.getElementById(`device-${actuator.itemId}`)).toBeInTheDocument()
    })

    it('saves an edited address and shows the error of a refused one', async () => {
      const user = userEvent.setup()
      serve(networks)
      const bodies: unknown[] = []
      let refuse = true
      server.use(
        http.put('/api/versions/:versionId/addresses', async ({ request }) => {
          bodies.push(await request.json())
          if (refuse) return HttpResponse.json({ status: 422, code: 'address.taken', params: { address: '1.2.7' } }, { status: 422 })
          return HttpResponse.json(addresses)
        }),
      )
      renderWithProviders(<NetworksTab projectId="p1" versionId={versionId} />)
      await user.click(await screen.findByRole('button', { name: 'Edit address of Switch actuator 8-fold · Kitchen, Ground floor' }))
      const input = screen.getByRole('textbox', { name: 'Address of Switch actuator 8-fold · Kitchen, Ground floor' })
      await user.clear(input)
      await user.type(input, '1.2.7{Enter}')
      const error = await screen.findByText('Another device already has the address 1.2.7.')
      // The error describes the input.
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(document.getElementById(input.getAttribute('aria-describedby') ?? '')).toContainElement(error)
      refuse = false
      await user.clear(input)
      await user.type(input, '1.1.9')
      await user.click(screen.getByRole('button', { name: 'Save address' }))
      await waitFor(() => expect(screen.queryByRole('textbox', { name: /Address of/ })).not.toBeInTheDocument())
      expect(bodies).toEqual([
        { addresses: [{ planId: actuator.planId, itemId: actuator.itemId, knx: '1.2.7' }] },
        { addresses: [{ planId: actuator.planId, itemId: actuator.itemId, knx: '1.1.9' }] },
      ])
    })

    it('clears an address by saving it empty (IEEE of a wireless device)', async () => {
      const user = userEvent.setup()
      serve(networks)
      const bodies: unknown[] = []
      server.use(
        http.put('/api/versions/:versionId/addresses', async ({ request }) => {
          bodies.push(await request.json())
          return HttpResponse.json(addresses)
        }),
      )
      renderWithProviders(<NetworksTab projectId="p1" versionId={versionId} />)
      await user.click(await screen.findByRole('button', { name: 'Edit address of Door sensor · Front door, Ground floor' }))
      await user.type(screen.getByRole('textbox', { name: /Address of Door sensor/ }), '00:12:4b:00:1c:a1:b2:c4{Enter}')
      await waitFor(() => expect(bodies).toEqual([{ addresses: [{ planId: doorSensor.planId, itemId: doorSensor.itemId, ieee: '00:12:4b:00:1c:a1:b2:c4' }] }]))
    })

    it('cancels with Escape, sends nothing for an unchanged value and clears with an empty one', async () => {
      const user = userEvent.setup()
      serve(networks)
      const bodies: unknown[] = []
      server.use(
        http.put('/api/versions/:versionId/addresses', async ({ request }) => {
          bodies.push(await request.json())
          return HttpResponse.json(addresses)
        }),
      )
      renderWithProviders(<NetworksTab projectId="p1" versionId={versionId} />)
      const edit = await screen.findByRole('button', { name: 'Edit address of Switch actuator 8-fold · Kitchen, Ground floor' })
      const input = () => screen.getByRole('textbox', { name: 'Address of Switch actuator 8-fold · Kitchen, Ground floor' })

      // Escape cancels.
      await user.click(edit)
      await user.clear(input())
      await user.type(input(), '1.1.4{Escape}')
      expect(screen.queryByRole('textbox', { name: /Address of/ })).not.toBeInTheDocument()

      // Unchanged: closes without a request (the automatic address stays automatic).
      await user.click(screen.getByRole('button', { name: 'Edit address of Switch actuator 8-fold · Kitchen, Ground floor' }))
      expect(input()).toHaveValue('1.1.1')
      await user.type(input(), '{Enter}')
      expect(screen.queryByRole('textbox', { name: /Address of/ })).not.toBeInTheDocument()

      // Empty clears.
      await user.click(screen.getByRole('button', { name: 'Edit address of Switch actuator 8-fold · Kitchen, Ground floor' }))
      await user.clear(input())
      await user.click(screen.getByRole('button', { name: 'Save address' }))
      await waitFor(() => expect(bodies).toEqual([{ addresses: [{ planId: actuator.planId, itemId: actuator.itemId }] }]))
    })

    it('shows the address of devices without a line or gateway', async () => {
      serve({ ...networks, busSystems: [{ ...networks.busSystems[0], unassigned: [actuator] }] })
      renderWithProviders(<NetworksTab projectId="p1" versionId={versionId} />)
      const table = await screen.findByRole('table', { name: 'KNX: Without line' })
      expect(within(table).getByRole('columnheader', { name: 'Address' })).toBeInTheDocument()
      expect(within(table).getByText('1.1.1')).toBeInTheDocument()
    })

    it('drops the assign notice after the next action', async () => {
      const user = userEvent.setup()
      serve(networks)
      server.use(
        http.post('/api/versions/:versionId/addresses/assign', () => HttpResponse.json({ ...addresses, assigned: 2, unassigned: 0 })),
        http.put('/api/versions/:versionId/addresses', () => HttpResponse.json(addresses)),
      )
      renderWithProviders(<NetworksTab projectId="p1" versionId={versionId} />)
      await user.click(await screen.findByRole('button', { name: 'Assign addresses on KNX 2' }))
      expect(await screen.findByText('2 devices got an automatic address.')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Edit address of Switch actuator 8-fold · Kitchen, Ground floor' }))
      await user.clear(screen.getByRole('textbox', { name: /Address of Switch actuator/ }))
      await user.type(screen.getByRole('textbox', { name: /Address of Switch actuator/ }), '1.1.9{Enter}')
      await waitFor(() => expect(screen.queryByText('2 devices got an automatic address.')).not.toBeInTheDocument())
    })

    it('warns about a line without a free default prefix', async () => {
      serve(networks, noChecks, { ...addresses, lines: [addresses.lines[0], { ...addresses.lines[1], prefix: undefined, noPrefix: true }] })
      renderWithProviders(<NetworksTab projectId="p1" versionId={versionId} />)
      expect(await screen.findByText(/No default line address is free/)).toBeInTheDocument()
    })

    it('assigns all lines or one line and clears automatic addresses', async () => {
      const user = userEvent.setup()
      serve(networks)
      const assigns: unknown[] = []
      let cleared = ''
      server.use(
        http.post('/api/versions/:versionId/addresses/assign', async ({ request }) => {
          assigns.push(await request.json())
          return HttpResponse.json({ ...addresses, assigned: 2, unassigned: 1 })
        }),
        http.delete('/api/versions/:versionId/addresses', ({ request }) => {
          cleared = new URL(request.url).search
          return HttpResponse.json(addresses)
        }),
      )
      renderWithProviders(<NetworksTab projectId="p1" versionId={versionId} />)
      await user.click(await screen.findByRole('button', { name: 'Assign addresses on KNX 2' }))
      await user.click(screen.getAllByRole('button', { name: 'Assign addresses' })[0])
      await waitFor(() => expect(assigns).toEqual([{ busLineIds: [lineTwo.id] }, {}]))
      expect(await screen.findByText(/2 devices got an automatic address. 1 device is still without address/)).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Clear automatic' }))
      const dialog = await screen.findByRole('dialog')
      await user.click(within(dialog).getByRole('button', { name: 'Clear' }))
      await waitFor(() => expect(cleared).toBe('?auto=true'))
    })

    it('warns about an unreadable line address', async () => {
      serve(networks, noChecks, { ...addresses, lines: [{ ...addresses.lines[0], prefix: undefined, invalid: true }, addresses.lines[1]] })
      renderWithProviders(<NetworksTab projectId="p1" versionId={versionId} />)
      expect(await screen.findByText('The line address “1.1” cannot be read: no automatic addresses on this line until it is corrected.')).toBeInTheDocument()
    })

    it('hides address controls when read only', async () => {
      serve({ ...networks, can: { update: false } })
      renderWithProviders(<NetworksTab projectId="p1" versionId={versionId} />)
      expect(await screen.findByText('1.1.1')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Assign addresses|Clear automatic|Edit address/ })).not.toBeInTheDocument()
    })
  })
})
