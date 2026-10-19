import { describe, expect, it } from 'vitest'

import { formatWatts, hasPower, parsePower } from './format'

describe('power per unit', () => {
  it('parses what people type into the API form with 2 decimals, like the backend accepts it', () => {
    expect(parsePower('7,5')).toBe('7.50')
    expect(parsePower('7.5')).toBe('7.50')
    expect(parsePower(' 60 ')).toBe('60.00')
    expect(parsePower('0')).toBe('0.00')
    expect(parsePower('007,25')).toBe('7.25')
    expect(parsePower('100000')).toBe('100000.00')
    expect(parsePower('')).toBeNull()
    for (const bad of ['7.555', '-1', '100000.01', 'abc', '1e3', '7,5,0']) expect(parsePower(bad)).toBeUndefined()
  })

  it('shows watts without trailing zeros in the UI language', () => {
    expect(formatWatts('7.50', ',')).toBe('7,5')
    expect(formatWatts('7.50', '.')).toBe('7.5')
    expect(formatWatts('60.00', ',')).toBe('60')
    expect(formatWatts('0.05', ',')).toBe('0,05')
    expect(formatWatts('120', '.')).toBe('120')
    expect(hasPower('0.00')).toBe(false)
    expect(hasPower('0.01')).toBe(true)
  })
})
