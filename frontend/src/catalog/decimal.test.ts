import { describe, expect, it } from 'vitest'

import { decimalSeparator, formatDecimal, parseDecimal } from './decimal'

describe('parseDecimal', () => {
  it('accepts a point or a comma as the decimal separator and returns the point form', () => {
    expect(parseDecimal('27')).toBe('27')
    expect(parseDecimal('27.50')).toBe('27.50')
    expect(parseDecimal('27,50')).toBe('27.50')
    expect(parseDecimal(' 1,5 ')).toBe('1.5')
    expect(parseDecimal(',5')).toBe('0.5')
    expect(parseDecimal('-0,25')).toBe('-0.25')
    expect(parseDecimal('-.5')).toBe('-0.5')
  })

  it.each(['', ' ', 'abc', '1.234,5', '1,234.5', '1.2.3', '1,2,3', '27.', '0x1A', '0b101', '0o7', '1e3', '1E-2', 'Infinity', '+5', '--1', '1 000', '½'])(
    'refuses %j',
    (text) => {
      expect(parseDecimal(text)).toBeUndefined()
    },
  )
})

describe('formatDecimal', () => {
  it('shows the decimal separator of the UI language and parses back to the same value', () => {
    expect(decimalSeparator('de')).toBe(',')
    expect(decimalSeparator('en')).toBe('.')
    expect(formatDecimal('27.50', ',')).toBe('27,50')
    expect(formatDecimal(2.5, ',')).toBe('2,5')
    expect(formatDecimal(-0.25, ',')).toBe('-0,25')
    expect(formatDecimal(4, ',')).toBe('4')
    expect(formatDecimal('27.50', '.')).toBe('27.50')
    expect(formatDecimal(1e21, ',')).toBe('1e+21')
    for (const v of ['27.50', '2.5', '-0.25', '120']) expect(parseDecimal(formatDecimal(v, ','))).toBe(v)
  })
})
