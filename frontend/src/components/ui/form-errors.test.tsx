import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/client'
import errorsDe from '@/locales/de/errors.json'
import errorsEn from '@/locales/en/errors.json'

import { apiFieldFor, apiFields, decodeMessage, errorKey, errorParamNames, formatParams, setApiFieldErrors, useFieldError } from './form-errors'
import { useErrorMessage } from './use-error-message'

type FieldErrorBody = { location: string; code: string; params?: Record<string, unknown> }
const invalid = (...fields: FieldErrorBody[]) => new ApiError({ status: 422, code: 'validation.failed', fields })

/** Every key of a namespace with the {{placeholders}} of its text. */
function placeholders(value: unknown, prefix = ''): Record<string, string[]> {
  if (typeof value === 'string') {
    const names = [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])
    return names.length > 0 ? { [prefix]: [...new Set(names)].sort() } : {}
  }
  return Object.assign({}, ...Object.entries(value as object).map(([k, v]) => placeholders(v, prefix ? `${prefix}.${k}` : k)))
}

describe('error params', () => {
  it('lists exactly the params every error text interpolates, in every language', () => {
    const listed = Object.fromEntries(Object.entries(errorParamNames).map(([k, v]) => [k, [...v].sort()]))
    expect(placeholders(errorsEn)).toEqual(listed)
    expect(placeholders(errorsDe)).toEqual(listed)
  })

  it('carries params in form messages and translates them', () => {
    const message = errorKey('validation.too_long', { max: 64 })
    expect(decodeMessage(message)).toEqual({ key: 'validation.too_long', params: { max: 64 } })
    expect(errorKey('validation.required')).toBe('validation.required')
    // @ts-expect-error a key whose text needs params cannot be used without them
    errorKey('validation.too_long')
    // @ts-expect-error nor with the wrong ones
    errorKey('attribute.range', { min: 1 })

    const { result } = renderHook(() => useFieldError())
    expect(result.current(message)).toBe('This value is too long (at most 64 characters).')
    expect(result.current(errorKey('attribute.bound_range', { min: 0, max: 10 }))).toBe('This limit must be between 0 and 10.')
    expect(result.current('unknown.code')).toBe('This value is invalid.')
    expect(result.current(undefined)).toBeUndefined()
  })
})

describe('API field errors', () => {
  const fields = apiFields<{ email: string; nameEn: string; attributes: string[] }>(['email', 'attributes'], { 'name.en': 'nameEn' })

  it('maps body locations to form fields', () => {
    expect(apiFieldFor('body.email', fields)).toBe('email')
    expect(apiFieldFor('body.name.en', fields)).toBe('nameEn')
    expect(apiFieldFor('body.attributes', fields)).toBe('attributes')
    expect(apiFieldFor('body.other', fields)).toBeUndefined()
    expect(apiFieldFor('body.constructor', fields)).toBeUndefined()
    expect(apiFieldFor('query.email', fields)).toBeUndefined()
    expect(apiFieldFor('body.email', undefined)).toBeUndefined()
  })

  it('maps list items only where the form lists them', () => {
    const nested = { key: 'key', attributes: 'attributes.root', 'attributes[2].key': 'attributes.2.key', 'attributes[2].options': 'attributes.2.options.root' }
    expect(apiFieldFor('body.attributes[2].key', nested)).toBe('attributes.2.key')
    expect(apiFieldFor('body.attributes[2].options', nested)).toBe('attributes.2.options.root')
    expect(apiFieldFor('body.attributes', nested)).toBe('attributes.root')
    // Not rendered: no field, so the message says it instead.
    expect(apiFieldFor('body.attributes[2].scope', nested)).toBeUndefined()
    expect(apiFieldFor('body.attributes[3].key', nested)).toBeUndefined()
    expect(apiFieldFor('body.attributes[2]', nested)).toBeUndefined()

    const setError = vi.fn()
    const shown = setApiFieldErrors(
      invalid(
        { location: 'body.attributes', code: 'validation.too_many', params: { max: 200 } },
        { location: 'body.attributes[2].key', code: 'attribute.key_duplicate' },
        { location: 'body.attributes[2].scope', code: 'validation.invalid' },
      ),
      setError,
      nested,
    )
    expect(shown).toBe(2)
    // A list's own error after its items' errors.
    expect(setError.mock.calls.map(([name, error]) => [name, error.message])).toEqual([
      ['attributes.2.key', 'attribute.key_duplicate'],
      ['attributes.root', 'validation.too_many {"max":200}'],
    ])
  })

  it('sets the field code with its params, or validation.invalid for unknown codes, at the field', () => {
    const setError = vi.fn()
    setApiFieldErrors(
      invalid(
        { location: 'body.email', code: 'user.email_taken', params: { email: 'a@b.c' } },
        { location: 'body.name.en', code: 'something.unknown', params: { x: 1 } },
        { location: 'body.elsewhere', code: 'validation.required' },
      ),
      setError,
      fields,
    )
    expect(setError.mock.calls.map(([name, error]) => [name, error.message])).toEqual([
      ['email', 'user.email_taken {"email":"a@b.c"}'],
      ['nameEn', 'validation.invalid'],
    ])
  })

  it('shows times in params (the expiry of a lock) localized, not as RFC 3339', () => {
    const { result } = renderHook(() => useErrorMessage())
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const message = result.current(new ApiError({ status: 409, code: 'plan.locked', params: { name: 'Eve', expiresAt } }))
    expect(message).toContain('Eve')
    expect(message).not.toContain(expiresAt)
    expect(message).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    const now = new Date('2026-10-19T10:00:00')
    const today = formatParams({ at: new Date('2026-10-19T14:32:00').toISOString(), n: 3, s: 'x' }, 'de', now)
    expect(today).toEqual({ at: '14:32', n: 3, s: 'x' })
    expect(String(formatParams({ at: new Date('2026-10-20T14:32:00').toISOString() }, 'en', now)?.at)).toMatch(/Oct 20, 2026/)
  })

  it('shows limits in params as localized numbers, exactly', () => {
    expect(formatParams({ max: '9999999999.99', min: 100000 }, 'de')).toEqual({ max: '9.999.999.999,99', min: '100.000' })
    expect(formatParams({ max: '9999999999.99' }, 'en')).toEqual({ max: '9,999,999,999.99' })
    expect(formatParams({ online: '278.5', currency: 'PKR' }, 'de')).toEqual({ online: '278,5', currency: 'PKR' })
    // Only limits: a SKU stays as it is.
    expect(formatParams({ sku: '12345' }, 'en')).toEqual({ sku: '12345' })
    const { result } = renderHook(() => useErrorMessage())
    expect(result.current(new ApiError({ status: 422, code: 'pricing.amount_range', params: { max: '9999999999.99' } }))).toBe('This amount is too large (at most 9,999,999,999.99).')
  })

  it('only says "check the highlighted fields" when every error is at a field', () => {
    const { result } = renderHook(() => useErrorMessage())
    const message = result.current
    // All shown at fields.
    expect(message(invalid({ location: 'body.email', code: 'validation.invalid' }), fields)).toBe('Please check the highlighted fields.')
    // Nothing highlighted: say what is wrong instead, with its params.
    expect(message(invalid({ location: 'body.email', code: 'validation.invalid' }))).toBe('This value is invalid.')
    expect(message(invalid({ location: 'body.other', code: 'validation.required' }), fields)).toBe('This field is required.')
    expect(message(invalid({ location: 'body.other', code: 'attribute.range', params: { min: 1, max: 12 } }), fields)).toBe(
      'Enter a value between 1 and 12.',
    )
    expect(message(invalid({ location: 'body.other', code: 'attribute.type', params: { expected: 'integer' } }), fields)).toBe(
      'This value must be a whole number.',
    )
    // Some at fields, some not.
    expect(
      message(invalid({ location: 'body.email', code: 'validation.invalid' }, { location: 'body.other', code: 'validation.invalid' }), fields),
    ).toBe('This value is invalid. Please check the highlighted fields.')
    // A validation error without any field details.
    expect(message(invalid(), fields)).toBe('The request was invalid.')
  })
})
