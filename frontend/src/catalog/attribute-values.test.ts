import { describe, expect, it } from 'vitest'

import type { AttributeDefinition } from '@/api/generated/model'

import { attributeFieldMap, extraKeys, formValueOf, toApiValue, toApiValues, toFormValue, toFormValues } from './attribute-values'

const def = (d: Partial<AttributeDefinition> & Pick<AttributeDefinition, 'key' | 'type'>): AttributeDefinition => ({ label: { en: d.key }, ...d })

const text = def({ key: 'series', type: 'text' })
const number = def({ key: 'power', type: 'number' })
const integer = def({ key: 'width', type: 'integer' })
const flag = def({ key: 'dali', type: 'boolean' })
const requiredFlag = def({ key: 'din', type: 'boolean', required: true })
const choice = def({ key: 'bus', type: 'enum', options: [{ key: 'knx', label: { en: 'KNX' } }] })
const numbers = def({ key: 'currents', type: 'list', itemType: 'number' })
const choices = def({ key: 'loads', type: 'list', itemType: 'enum' })

describe('attribute values', () => {
  it('round-trips stored values through the form unchanged', () => {
    const stored = { series: 'Pro', power: 12.5, width: 4, dali: false, bus: 'knx', currents: [1.5, 2], loads: ['led'] }
    const defs = [text, number, integer, flag, choice, numbers, choices]
    const values = toFormValues(defs, stored)
    expect(values).toEqual({ series: 'Pro', power: '12.5', width: '4', dali: false, bus: 'knx', currents: ['1.5', '2'], loads: ['led'] })
    expect(toApiValues(defs, values)).toEqual({ attributes: stored, errors: {} })
  })

  it('leaves out what is not set: blank text and choices, empty lists, an untouched yes/no', () => {
    const defs = [text, number, flag, choice, numbers]
    expect(toApiValues(defs, toFormValues(defs, {}))).toEqual({ attributes: {}, errors: {} })
    expect(toApiValues(defs, { series: '  ', power: '', dali: null, bus: '', currents: [] }).attributes).toEqual({})
    // A required yes/no starts as "no": a checkbox has no "not set".
    expect(toFormValue(requiredFlag, undefined)).toBe(false)
  })

  it('reports text that is not a number, or not a whole number', () => {
    expect(toApiValue(number, 'abc')).toEqual({ error: 'validation.number' })
    expect(toApiValue(integer, '2.5')).toEqual({ error: 'attribute.type {"expected":"integer"}' })
    expect(toApiValue(numbers, ['1', 'x'])).toEqual({ error: 'validation.number' })
    expect(toApiValue(number, ' 7 ')).toEqual({ value: 7 })
  })

  it('shows values stored for another type as well as possible', () => {
    expect(toFormValue(numbers, 3)).toEqual(['3'])
    expect(toFormValue(text, ['a', 'b'])).toBe('a, b')
    expect(toFormValue(flag, 'yes')).toEqual({ raw: 'yes' })
    // A key edited under another definition, e.g. before the type changed.
    expect(formValueOf(numbers, { currents: '4' })).toEqual(['4'])
    expect(formValueOf(text, { series: ['a'] })).toBe('a')
    expect(formValueOf(flag, { dali: 'x' })).toBeNull()
    expect(formValueOf(text, {})).toBe('')
  })

  it('finds stored keys outside the definitions and maps error locations to fields', () => {
    expect(extraKeys([text], { series: 'x', zeta: 1, alpha: 2 })).toEqual(['alpha', 'zeta'])
    expect(attributeFieldMap([text, numbers], { currents: ['1', '2'] }, ['old'])).toEqual({
      'attributes.series': 'values.series',
      'attributes.currents': 'values.currents',
      'attributes.currents[0]': 'values.currents',
      'attributes.currents[1]': 'values.currents',
      'attributes.old': 'keep.old',
    })
  })

  it('keeps stored values the input cannot hold raw and sends them back unchanged', () => {
    const objects = def({ key: 'channels', type: 'list', itemType: 'text' })
    const stored = { dali: 'yes', channels: [{ n: 1 }, 'b'], series: { a: 1 } }
    const values = toFormValues([flag, objects, text], stored)
    expect(values).toEqual({ dali: { raw: 'yes' }, channels: { raw: [{ n: 1 }, 'b'] }, series: { raw: { a: 1 } } })
    expect(toApiValues([flag, objects, text], values)).toEqual({ attributes: stored, errors: {} })
    // Once the input is changed, the new value is sent.
    expect(toApiValues([flag, objects], { ...values, dali: true, channels: ['x'] }).attributes).toEqual({ dali: true, channels: ['x'] })
    // Item errors of a raw list map to the list.
    expect(attributeFieldMap([objects], values, [])).toEqual({
      'attributes.channels': 'values.channels',
      'attributes.channels[0]': 'values.channels',
      'attributes.channels[1]': 'values.channels',
    })
  })

  it('takes a decimal comma and refuses hex and exponent forms', () => {
    expect(toApiValue(number, '12,5')).toEqual({ value: 12.5 })
    expect(toApiValue(integer, '4,0')).toEqual({ value: 4 })
    expect(toApiValue(numbers, ['1,5', '2'])).toEqual({ value: [1.5, 2] })
    expect(toApiValue(number, '0x10')).toEqual({ error: 'validation.number' })
    expect(toApiValue(number, '1e3')).toEqual({ error: 'validation.number' })
    expect(toApiValue(integer, '0b11')).toEqual({ error: 'validation.number' })
  })

  it('round-trips stored 0 and false', () => {
    const defs = [number, integer, flag]
    const stored = { power: 0, width: 0, dali: false }
    expect(toApiValues(defs, toFormValues(defs, stored)).attributes).toEqual(stored)
  })
})
