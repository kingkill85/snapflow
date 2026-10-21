import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { Finding } from '@/api/generated/model'
import { renderWithProviders } from '@/test/render'

import { findingsOf } from './findings'
import { FindingsList } from './FindingsList'

const plan = 'plan-1'
const findings: Finding[] = [
  { severity: 'error', code: 'variant_deleted', refs: { targetPlanId: plan, itemId: 'a' }, params: { label: 'D1' } },
  { severity: 'warning', code: 'need_outside_zones', refs: { planId: plan, needId: 'n' }, params: { label: 'Spots' } },
  { severity: 'info', code: 'module_width_unknown', refs: { targetPlanId: plan, itemId: 'b' }, params: { label: 'R1' } },
  { severity: 'warning', code: 'bus_line_no_power_supply', refs: { busLineId: 'l' }, params: { name: 'KNX 1' } },
]

describe('FindingsList', () => {
  it('lists the findings by severity with the former plan warning texts and a link per finding', () => {
    renderWithProviders(<FindingsList findings={findings} linkOf={(f) => (f.refs.itemId ? `/edit?select=${f.refs.itemId}` : null)} />)
    expect(screen.getByText('Errors')).toBeInTheDocument()
    expect(screen.getByText('D1: the product was deleted from the catalog.')).toBeInTheDocument()
    expect(screen.getByText('Spots: the symbol lies outside every zone.')).toBeInTheDocument()
    expect(screen.getByText('R1: the rail width is unknown, counted as 1 TE.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open: D1: the product was deleted from the catalog.' })).toHaveAttribute('href', '/edit?select=a')
    expect(screen.getAllByRole('link')).toHaveLength(2)
  })

  it('groups by plan with a version group last and offers Show in an editor', async () => {
    const onShow = vi.fn()
    renderWithProviders(<FindingsList findings={findings} plans={[{ id: plan, name: 'Ground floor' }]} onShow={onShow} />)
    const ground = screen.getByRole('region', { name: 'Ground floor' })
    expect(within(ground).getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByRole('region', { name: 'Version (networks)' })).toHaveTextContent('KNX 1')
    await userEvent.click(within(ground).getByRole('button', { name: 'Show: Spots: the symbol lies outside every zone.' }))
    expect(onShow).toHaveBeenCalledWith(findings[1])
  })

  it('names the add-on of an add-on warning (D453)', () => {
    renderWithProviders(
      <FindingsList
        findings={[{ severity: 'warning', code: 'addon_unavailable', refs: { targetPlanId: plan, itemId: 'a' }, params: { label: 'D1', addonProductName: { en: 'Push button' }, addonVariantName: { en: 'White' } } }]}
      />,
    )
    expect(screen.getByText('D1: a chosen add-on is not available (Push button – White).')).toBeInTheDocument()
  })

  it('says when there is nothing and picks the findings of one item', () => {
    renderWithProviders(<FindingsList findings={[]} />)
    expect(screen.getByText('No problems found.')).toBeInTheDocument()
    expect(findingsOf(findings, plan, 'n')).toEqual([findings[1]])
    expect(findingsOf(findings, plan, 'a')).toEqual([findings[0]])
  })
})
