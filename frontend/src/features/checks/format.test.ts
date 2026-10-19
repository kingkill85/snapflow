import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import i18n from '@/i18n'
import { resources } from '@/i18n/resources'

import { findingCodes, statusTone, unconnectableReasons, useFindingText, useReasonText } from './format'

describe('checks texts', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('has a text for every finding code and reason in en and de', () => {
    for (const lng of ['en', 'de'] as const) {
      for (const code of findingCodes) expect(resources[lng].checks.finding[code], `${lng} ${code}`).toBeTruthy()
      for (const reason of unconnectableReasons) expect(resources[lng].checks.reason[reason]).toBeTruthy()
    }
  })

  it('writes bus line reserves in plain words with the language number format', async () => {
    const { result, rerender } = renderHook(() => useFindingText())
    const finding = { code: 'bus_line_current_reserve', params: { name: 'KNX 1', usedMa: 612.5, suppliedMa: 640, reservePercent: 20 } }
    expect(result.current(finding)).toBe('KNX 1: 612.5 of 640 mA used (reserve 20 %)')
    await i18n.changeLanguage('de')
    rerender()
    expect(result.current(finding)).toBe('KNX 1: 612,5 von 640 mA belegt (Reserve 20 %)')
  })

  it('uses resolved names and falls back to params and generic words', () => {
    const { result } = renderHook(() => useFindingText())
    const unconnected = { code: 'need_unconnected', params: { missing: 2, quantity: 5, functionTypeKey: 'dimmable_light', label: 'Ceiling' } }
    expect(result.current(unconnected, { need: '5 × Dimmable light · Ceiling' })).toBe('5 × Dimmable light · Ceiling: 2 of 5 not connected')
    expect(result.current(unconnected)).toBe('Ceiling: 2 of 5 not connected')
    expect(result.current({ code: 'channel_overload_w', params: { loadW: 450, limitW: 400, utilisationPercent: 112.5 } })).toBe(
      'a channel: 450 W connected, at most 400 W (112.5 % of the limit)',
    )
    // A device without channels is not in the wiring view: its label, else its product name from params.
    expect(result.current({ code: 'board_row_over_capacity', params: { name: 'Sub board', row: 1, usedTe: 13, capacityTe: 12 } })).toBe(
      'Sub board, row 1: 13 of 12 TE used, more than fits',
    )
    expect(result.current({ code: 'network_assignment_dangling', params: { label: 'GW 1', kind: 'bus_line' } })).toBe(
      'GW 1 is assigned to a bus line that no longer exists',
    )
    expect(result.current({ code: 'motor_mismatch', params: { motorType: 'ac', needMotorType: 'dc' } }, { need: 'Blind', channel: 'ch 2' })).toBe(
      'Blind: DC motor on ch 2, which drives AC motors',
    )
    expect(result.current({ code: 'module_overload_w', params: { loadW: 900, limitW: 800 } }, { item: 'Dimmer D1' })).toBe(
      'Dimmer D1: 900 W in total (all loads), at most 800 W',
    )
    expect(result.current({ code: 'something_new', params: {} })).toBe('Check something_new')
  })

  it('gives auto-connect reasons and status tones', () => {
    const { result } = renderHook(() => useReasonText())
    expect(result.current('no_channel_serves', 'Towel heater')).toBe('No channel serves Towel heater')
    expect(statusTone('ok')).toBe('success')
    expect(statusTone('amber')).toBe('warning')
    expect(statusTone('red')).toBe('danger')
    expect(statusTone('unknown')).toBe('neutral')
  })
})
