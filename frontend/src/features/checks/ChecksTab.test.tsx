import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { AutoConnectPreview, Candidates } from '@/api/generated/model'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { ChecksTab } from './ChecksTab'
import { batchId, boardId, checks, lineId, ceiling, dimmer, dimmerKind, floorId, kitchen, projectId, relay, relayKind, serveChecks, versionId, wiring } from './test-fixtures'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const render = () => renderWithProviders(<ChecksTab projectId={projectId} versionId={versionId} />)

const preview = (extra: Partial<AutoConnectPreview> = {}): AutoConnectPreview => ({
  connections: [{ needPlanId: floorId, needId: ceiling, units: 1, targetPlanId: boardId, targetItemId: dimmer, outputKindId: dimmerKind, channelNo: 2 }],
  unconnectable: [{ needPlanId: floorId, needId: wiring.needs[0].needId, units: 3, reason: 'no_free_channel', params: { functionTypeKey: 'light' } }],
  needs: 2,
  units: 4,
  connectedUnits: 1,
  checksum: 'abc',
  ...extra,
})

describe('ChecksTab', () => {
  it('without needs and devices says there is nothing to check and links to the plans', async () => {
    serveChecks({ checks: { ...checks, findings: [], counts: { ...checks.counts, errors: 0, warnings: 0, infos: 0 } }, wiring: { ...wiring, items: [], needs: [], connections: [] } })
    render()
    expect(await screen.findByText('Nothing to check yet. Add needs to the rooms of a floorplan and devices to a board.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to the plans' })).toHaveAttribute('href', `/projects/${projectId}/versions/${versionId}`)
    expect(screen.queryByText('Zones covered')).not.toBeInTheDocument()
  })

  it('says "No problems found." when there are no findings', async () => {
    serveChecks({ checks: { ...checks, findings: [], counts: { ...checks.counts, errors: 0, warnings: 0, infos: 0 } } })
    render()
    expect(await screen.findByText('No problems found.')).toBeInTheDocument()
  })

  it('shows the overview cards with statuses', async () => {
    serveChecks()
    render()
    expect(await screen.findByText('Zones covered')).toBeInTheDocument()
    expect(screen.getByText('0 / 2')).toBeInTheDocument()
    expect(screen.getByText('Not all covered')).toBeInTheDocument()
    expect(screen.getByText('3 of 7 connected')).toBeInTheDocument()
    expect(screen.getByText('Dimmer output: 1 of 2 free')).toBeInTheDocument()
    expect(screen.getByText('Blind output (from other channels): 1 of 2 free')).toBeInTheDocument()
    expect(screen.getByText('8 of 12 TE used')).toBeInTheDocument()
    expect(screen.getByText('612 of 640 mA (reserve 20 %)')).toBeInTheDocument()
    expect(screen.getAllByText('Near limit').length).toBeGreaterThan(0)
  })

  it('groups findings by plan, then severity, and links to the editors (D454)', async () => {
    serveChecks()
    render()
    const findings = await screen.findByRole('region', { name: 'Findings' })
    expect(within(findings).getByText('Dimmer output 1', { exact: false })).toHaveTextContent('D1 · Dimmer output 1 (Main board): 140 W connected, at most 100 W')
    expect(within(within(findings).getByRole('region', { name: 'Main board' })).getByText('Errors')).toBeInTheDocument()
    expect(within(findings).getByRole('region', { name: 'Ground floor' })).toHaveTextContent('1 need has units that are not connected')
    expect(within(findings).getByRole('region', { name: 'Version (networks)' })).toHaveTextContent('KNX 1: 612 of 640 mA used')
    const links = within(findings).getAllByRole('link')
    expect(links[0]).toHaveAttribute('href', `/projects/${projectId}/versions/${versionId}/boards/${boardId}?select=${dimmer}`)
    // Unconnected needs are one line here; they are listed with Connect… below (D417).
    expect(within(findings).getByText('1 need has units that are not connected (listed under Unconnected needs)')).toBeInTheDocument()
    expect(links[1]).toHaveAttribute('href', `/projects/${projectId}/versions/${versionId}?tab=networks#line-${lineId}`)
    expect(within(findings).getByText('KNX 1: 612 of 640 mA used (reserve 20 %)')).toBeInTheDocument()
  })

  it('lists the plans\' content warnings under their plan with a link that selects the item (D453)', async () => {
    serveChecks({
      checks: {
        ...checks,
        findings: [
          { severity: 'info', code: 'module_width_unknown', refs: { targetPlanId: boardId, itemId: relay }, params: { label: 'R1' } },
          { severity: 'warning', code: 'need_outside_zones', refs: { planId: floorId, needId: ceiling }, params: { label: 'Spots' } },
        ],
      },
    })
    render()
    const findings = await screen.findByRole('region', { name: 'Findings' })
    const board = within(findings).getByRole('region', { name: 'Main board' })
    expect(within(board).getByText('Notes')).toBeInTheDocument()
    expect(within(board).getByRole('link', { name: /rail width is unknown/ })).toHaveAttribute('href', `/projects/${projectId}/versions/${versionId}/boards/${boardId}?select=${relay}`)
    const floor = within(findings).getByRole('region', { name: 'Ground floor' })
    expect(within(floor).getByRole('link', { name: /outside every zone/ })).toHaveAttribute('href', `/projects/${projectId}/versions/${versionId}/plans/${floorId}?select=${ceiling}`)
  })

  it('lists unconnected needs by plan and zone and connects one with the picker', async () => {
    serveChecks()
    const candidates: Candidates = {
      items: [
        { needPlanId: floorId, needId: ceiling, targetPlanId: boardId, targetItemId: dimmer, outputKindId: dimmerKind, channelNo: 2, units: 1, free: true, inZone: false },
        {
          needPlanId: floorId,
          needId: ceiling,
          targetPlanId: boardId,
          targetItemId: relay,
          outputKindId: relayKind,
          channelNo: 1,
          units: 0,
          free: false,
          inZone: false,
          problem: { code: 'channel_conflict', params: { baseChannel: 1 } },
        },
      ],
    }
    let created: unknown = null
    server.use(
      http.post('/api/versions/:versionId/connections/candidates', () => HttpResponse.json(candidates)),
      http.post('/api/versions/:versionId/connections', async ({ request }) => {
        created = await request.json()
        return HttpResponse.json({ connection: { ...wiring.connections[0], id: 'new' }, warnings: [] }, { status: 201 })
      }),
    )
    render()
    const section = await screen.findByRole('region', { name: 'Unconnected needs' })
    const kitchenList = within(section).getByRole('list', { name: 'Ground floor · Kitchen' })
    expect(kitchenList).toHaveTextContent('5 × Light · Spots — 2 of 5 connected')
    const livingList = within(section).getByRole('list', { name: 'Ground floor · Living room' })
    await userEvent.click(within(livingList).getByRole('button', { name: 'Connect 1 × Light…' }))

    const dialog = await screen.findByRole('dialog', { name: 'Connect 1 × Light' })
    expect(await within(dialog).findByText('D1 · Dimmer output 2 (Main board)')).toBeInTheDocument()
    expect(within(dialog).getByText(/^Switch actuator · Relay output 1 \(Main board\) uses output 1, which another channel uses too$/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect to D1 · Dimmer output 2 (Main board)' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(created).toEqual({ needPlanId: floorId, needId: ceiling, units: 1, targetPlanId: boardId, targetItemId: dimmer, outputKindId: dimmerKind, channelNo: 2 })
  })

  it('shows why no channel fits', async () => {
    serveChecks()
    server.use(http.post('/api/versions/:versionId/connections/candidates', () => HttpResponse.json({ items: [], reason: 'no_channel_serves' })))
    render()
    const section = await screen.findByRole('region', { name: 'Unconnected needs' })
    await userEvent.click(within(section).getByRole('button', { name: 'Connect 1 × Light…' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('No channel serves Light')).toBeInTheDocument()
  })

  it('shows the reason and the refused candidates with their rule when nothing fits', async () => {
    serveChecks()
    const refused = (item: string, kindId: string, no: number, code: string, params: Record<string, unknown>) => ({
      needPlanId: floorId,
      needId: ceiling,
      targetPlanId: boardId,
      targetItemId: item,
      outputKindId: kindId,
      channelNo: no,
      units: 0,
      free: true,
      inZone: false,
      problem: { code, params },
    })
    server.use(
      http.post('/api/versions/:versionId/connections/candidates', () =>
        HttpResponse.json({
          items: [
            refused(dimmer, dimmerKind, 2, 'channel_overload_w', { loadW: 250, limitW: 200, utilisationPercent: 125 }),
            refused(relay, relayKind, 1, 'channel_conflict', { baseChannel: 1 }),
            refused(relay, relayKind, 2, 'channel_overload_a', { currentA: 17.39, voltage: 230, limitA: 16, utilisationPercent: 109 }),
            refused(relay, relayKind, 3, 'channel_overload_a', { currentA: 17.39, voltage: 230, limitA: 16, utilisationPercent: 109 }),
          ],
          reason: 'limits_exceeded',
        } satisfies Candidates),
      ),
    )
    render()
    const section = await screen.findByRole('region', { name: 'Unconnected needs' })
    await userEvent.click(within(section).getByRole('button', { name: 'Connect 1 × Light…' }))
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Too large for every available channel (power, current or motor type)')).toBeInTheDocument()
    expect(within(dialog).getByText('4 not possible:')).toBeInTheDocument()
    expect(within(dialog).getByText('D1 · Dimmer output 2 (Main board): would draw 250 W (at most 200 W)')).toBeInTheDocument()
    // Identical refusals are one line.
    expect(within(dialog).getByText('2 channels: would draw 17.39 A at 230 V (at most 16 A)')).toBeInTheDocument()
    expect(within(dialog).getByText(/^Switch actuator · Relay output 1 \(Main board\) uses output 1, which another channel uses too$/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /^Connect to / })).not.toBeInTheDocument()
  })

  it('names devices without channels and boards without channel modules from the finding params', async () => {
    const sensor = '00000000-0000-4000-8000-000000000099'
    serveChecks({
      checks: {
        ...checks,
        findings: [
          { severity: 'error', code: 'board_row_over_capacity', refs: { targetPlanId: id(12) }, params: { name: 'Sub board', row: 2, usedTe: 14, capacityTe: 12 } },
          { severity: 'warning', code: 'bus_device_unassigned', refs: { targetPlanId: floorId, itemId: sensor }, params: { label: '', productName: { en: 'Presence sensor', de: 'Präsenzmelder' } } },
          { severity: 'warning', code: 'network_assignment_dangling', refs: { targetPlanId: floorId, itemId: sensor }, params: { label: 'PIR 1', kind: 'gateway' } },
        ],
      },
    })
    render()
    const findings = await screen.findByRole('region', { name: 'Findings' })
    expect(within(findings).getByText('Sub board, row 2: 14 of 12 TE used, more than fits')).toBeInTheDocument()
    expect(within(findings).getByText('Presence sensor is on no bus line')).toBeInTheDocument()
    expect(within(findings).getByText('PIR 1 is assigned to a gateway that no longer exists')).toBeInTheDocument()
    const links = within(findings).getAllByRole('link')
    // The floorplan's group first, then the board the plans list does not know (version group).
    expect(links[0]).toHaveAttribute('href', `/projects/${projectId}/versions/${versionId}/plans/${floorId}?select=${sensor}`)
    expect(links[1]).toHaveAttribute('href', `/projects/${projectId}/versions/${versionId}?tab=networks`)
  })

  it('links address findings to the device or line in the Networks tab', async () => {
    const sensor = '00000000-0000-4000-8000-000000000099'
    serveChecks({
      checks: {
        ...checks,
        findings: [
          { severity: 'error', code: 'address_duplicate', refs: { targetPlanId: floorId, itemId: sensor }, params: { label: 'PIR 1', address: '1.1.5', count: 2 } },
          { severity: 'warning', code: 'address_outside_line', refs: { targetPlanId: floorId, itemId: sensor, busLineId: lineId }, params: { label: 'PIR 1', address: '1.2.5', line: 'KNX 1', prefix: '1.1' } },
          { severity: 'info', code: 'address_missing', refs: { busLineId: lineId }, params: { name: 'KNX 1', count: 3 } },
        ],
      },
    })
    render()
    const findings = await screen.findByRole('region', { name: 'Findings' })
    expect(within(findings).getByRole('region', { name: 'Version (networks)' })).toBeInTheDocument()
    expect(within(findings).getByText('KNX 1: 3 devices without address')).toBeInTheDocument()
    const links = within(findings).getAllByRole('link')
    const tab = `/projects/${projectId}/versions/${versionId}?tab=networks`
    expect(links[0]).toHaveAttribute('href', `${tab}#device-${sensor}`)
    expect(links[1]).toHaveAttribute('href', `${tab}#device-${sensor}`)
    expect(links[2]).toHaveAttribute('href', `${tab}#line-${lineId}`)
  })

  it('auto-connects with a preview, re-previews on 409 and undoes the batch', async () => {
    serveChecks()
    let previews = 0
    let applies = 0
    let undone = false
    server.use(
      http.post('/api/versions/:versionId/auto-connect/preview', () => {
        previews++
        return HttpResponse.json(preview({ checksum: `c${previews}` }))
      }),
      http.post('/api/versions/:versionId/auto-connect/apply', async ({ request }) => {
        applies++
        const body = (await request.json()) as { expectedChecksum: string }
        if (body.expectedChecksum === 'c1') return HttpResponse.json({ status: 409, code: 'auto_connect.changed', title: 'Conflict' }, { status: 409 })
        return HttpResponse.json({ batchId, connections: [wiring.connections[0]] })
      }),
      http.delete('/api/versions/:versionId/auto-connect/:batchId', () => {
        undone = true
        return HttpResponse.json({ removed: 1 })
      }),
    )
    render()
    await userEvent.click(await screen.findByRole('button', { name: 'Auto-connect…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Auto-connect' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Preview' }))
    expect(await within(dialog).findByText('1 unit will be connected, 3 cannot:')).toBeInTheDocument()
    expect(within(dialog).getByRole('list', { name: 'Needs that cannot be connected' })).toHaveTextContent('5 × Light · Spots — Ground floor · Kitchen3 units: No free channel for Light')

    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }))
    expect(await within(dialog).findByText('The version changed since the preview. This is the new preview.')).toBeInTheDocument()
    expect(previews).toBe(2)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(applies).toBe(2)
    expect(screen.getByText('Auto-connect made 1 connection.')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Undo auto-connect' }))
    expect(await screen.findByText('Auto-connect undone: 1 connection removed.')).toBeInTheDocument()
    expect(undone).toBe(true)
  })

  it('limits auto-connect to selected zones', async () => {
    serveChecks()
    let body: unknown = null
    server.use(
      http.post('/api/versions/:versionId/auto-connect/preview', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json(preview({ unconnectable: [], units: 1 }))
      }),
    )
    render()
    await userEvent.click(await screen.findByRole('button', { name: 'Auto-connect…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Auto-connect' })
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Needs' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Needs of selected zones' }))
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Kitchen/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Preview' }))
    expect(await within(dialog).findByText('1 unit will be connected.')).toBeInTheDocument()
    expect(body).toEqual({ scope: 'zones', zoneIds: [kitchen] })
  })

  it('hides writes on a read-only version', async () => {
    serveChecks({ wiring: { ...wiring, can: { update: false } } })
    render()
    await screen.findByRole('region', { name: 'Unconnected needs' })
    expect(screen.queryByRole('button', { name: 'Auto-connect…' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Connect / })).not.toBeInTheDocument()
  })
})
