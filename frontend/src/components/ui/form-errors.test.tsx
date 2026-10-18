import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/client'

import { apiFieldFor, apiFields, setApiFieldErrors } from './form-errors'
import { useErrorMessage } from './use-error-message'

const invalid = (...fields: { location: string; code: string }[]) =>
  new ApiError({ status: 422, code: 'validation.failed', fields })

describe('API field errors', () => {
  const fields = apiFields<{ email: string; nameEn: string; attributes: string[] }>(['email', 'attributes'], { 'name.en': 'nameEn' })

  it('maps body locations to form fields', () => {
    expect(apiFieldFor('body.email', fields)).toBe('email')
    expect(apiFieldFor('body.name.en', fields)).toBe('nameEn')
    expect(apiFieldFor('body.attributes[2].key', fields)).toBe('attributes')
    expect(apiFieldFor('body.other', fields)).toBeUndefined()
    expect(apiFieldFor('body.constructor', fields)).toBeUndefined()
    expect(apiFieldFor('query.email', fields)).toBeUndefined()
    expect(apiFieldFor('body.email', undefined)).toBeUndefined()
  })

  it('maps locations inside field arrays to the same nested form path', () => {
    type Form = { key: string; name: { en: string }; attributes: { key: string; options: { key: string }[] }[] }
    const nested = apiFields<Form>(['key', 'name.en'], {}, ['attributes'])
    expect(apiFieldFor('body.attributes[2].key', nested)).toBe('attributes.2.key')
    expect(apiFieldFor('body.attributes[2].options[0].key', nested)).toBe('attributes.2.options.0.key')
    expect(apiFieldFor('body.attributes[12].options[3].label.en', nested)).toBe('attributes.12.options.3.label.en')
    expect(apiFieldFor('body.attributes[0].options', nested)).toBe('attributes.0.options')
    expect(apiFieldFor('body.name.en', nested)).toBe('name.en')
    // The array itself or one of its items has no field to show the error.
    expect(apiFieldFor('body.attributes', nested)).toBeUndefined()
    expect(apiFieldFor('body.attributes[2]', nested)).toBeUndefined()
    expect(apiFieldFor('body.instanceAttributes[0].key', nested)).toBeUndefined()

    const setError = vi.fn()
    setApiFieldErrors(
      invalid(
        { location: 'body.attributes[1].options[0].key', code: 'attribute.option_key_duplicate' },
        { location: 'body.attributes[1]', code: 'validation.invalid' },
      ),
      setError,
      nested,
    )
    expect(setError.mock.calls.map(([name, error]) => [name, error.message])).toEqual([
      ['attributes.1.options.0.key', 'attribute.option_key_duplicate'],
    ])
  })

  it('sets the field code, or validation.invalid for unknown codes, at the field', () => {
    const setError = vi.fn()
    setApiFieldErrors(
      invalid(
        { location: 'body.email', code: 'user.email_taken' },
        { location: 'body.name.en', code: 'something.unknown' },
        { location: 'body.elsewhere', code: 'validation.required' },
      ),
      setError,
      fields,
    )
    expect(setError.mock.calls.map(([name, error]) => [name, error.message])).toEqual([
      ['email', 'user.email_taken'],
      ['nameEn', 'validation.invalid'],
    ])
  })

  it('only says "check the highlighted fields" when every error is at a field', () => {
    const { result } = renderHook(() => useErrorMessage())
    const message = result.current

    // All shown at fields.
    expect(message(invalid({ location: 'body.email', code: 'validation.invalid' }), fields)).toBe('Please check the highlighted fields.')
    // Nothing highlighted: say what is wrong instead.
    expect(message(invalid({ location: 'body.email', code: 'validation.invalid' }))).toBe('This value is invalid.')
    expect(message(invalid({ location: 'body.other', code: 'validation.required' }), fields)).toBe('This field is required.')
    // Some at fields, some not.
    expect(
      message(invalid({ location: 'body.email', code: 'validation.invalid' }, { location: 'body.other', code: 'validation.invalid' }), fields),
    ).toBe('This value is invalid. Please check the highlighted fields.')
    // A validation error without any field details.
    expect(message(invalid(), fields)).toBe('The request was invalid.')
  })
})
