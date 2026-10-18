import { describe, expect, it } from 'vitest'

import { parseDecimal } from './decimal'

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
