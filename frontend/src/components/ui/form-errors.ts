import type { ParseKeys } from 'i18next'
import i18next from 'i18next'
import type { FieldErrors, FieldValues, Path, UseFormSetError } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/client'

/** A key of the errors namespace, e.g. "validation.required". */
export type ErrorKey = ParseKeys<'errors'>

/**
 * The params each error text interpolates, by key (e.g. "{{max}}"). A key
 * listed here can only be used with its params; form-errors.test.ts checks
 * this list against errors.json, so a new placeholder cannot be forgotten.
 */
export const errorParamNames = {
  'attribute.bound_range': ['min', 'max'],
  'attribute.count': ['min', 'max'],
  'attribute.count_max': ['max'],
  'attribute.count_min': ['min'],
  'attribute.length': ['min', 'max'],
  'attribute.length_max': ['max'],
  'attribute.length_min': ['min'],
  'attribute.min_above_options': ['max'],
  'attribute.option': ['options'],
  'attribute.range': ['min', 'max'],
  'attribute.range_invalid': ['min'],
  'attribute.range_max': ['max'],
  'attribute.range_min': ['min'],
  'attribute.required_max': ['min'],
  'attribute.type': ['expected'],
  'attribute.wrong_scope': ['scope'],
  'auth.too_many_attempts': ['seconds'],
  'file.too_large': ['maxMb'],
  'file.too_many_pixels': ['megapixels'],
  'function_type.key_taken': ['key'],
  'product.model_number_taken': ['modelNumber'],
  'product_type.key_taken': ['key'],
  'tenant.name_taken': ['name'],
  'user.email_taken': ['email'],
  'variant.name_taken': ['name'],
  'variant.sku_taken': ['sku'],
  'validation.too_long': ['max'],
  'validation.too_many': ['max'],
} as const satisfies Partial<Record<ErrorKey, readonly string[]>>

type ParamKey = keyof typeof errorParamNames
/** The params of an error key, e.g. { max: 100 } for "validation.too_long". */
export type ErrorParams<K extends ErrorKey> = K extends ParamKey
  ? { [P in (typeof errorParamNames)[K][number]]: string | number }
  : never

// A form message is the key, or the key and its params as JSON after a space
// (keys never contain spaces). React-hook-form and zod only carry strings.
const encode = (key: string, params?: Record<string, unknown>) =>
  params && Object.keys(params).length > 0 ? `${key} ${JSON.stringify(params)}` : key

/** The key and params of a form message (see errorKey). */
export function decodeMessage(message: string): { key: string; params?: Record<string, unknown> } {
  const space = message.indexOf(' ')
  if (space < 0) return { key: message }
  try {
    return { key: message.slice(0, space), params: JSON.parse(message.slice(space + 1)) as Record<string, unknown> }
  } catch {
    return { key: message.slice(0, space) }
  }
}

/**
 * An error key (and its params) as a form message, e.g. in a zod schema:
 * `z.string().max(100, errorKey('validation.too_long', { max: 100 }))`.
 * A typo, or a key used without the params its text needs, is a type error.
 */
export function errorKey<K extends ErrorKey>(key: K, ...params: K extends ParamKey ? [ErrorParams<K>] : []): string {
  return encode(key, params[0])
}

const knownError = (code: string): ErrorKey => (i18next.exists(code, { ns: 'errors' }) ? (code as ErrorKey) : 'validation.invalid')

/** Translates a form field's error message (an error key from zod or the API, with its params). */
export function useFieldError() {
  const { t } = useTranslation('errors')
  return (message?: string): string | undefined => {
    if (!message) return undefined
    const { key, params } = decodeMessage(message)
    const known = knownError(key)
    return String(t(known, (known === key ? params : undefined) as never))
  }
}

/**
 * Which API field locations (below "body.") a form shows at which of its fields,
 * e.g. { email: 'email', 'name.en': 'nameEn', 'attributes[2].key': 'attributes.2.key' }.
 * List only fields the form renders, so an error is never reported as
 * "highlighted" without a visible field. A target ending in ".root" is the
 * error of a whole field array (e.g. too many items), shown next to the list.
 */
export type ApiFieldMap = Readonly<Record<string, string>>

/** Builds an ApiFieldMap: each named field at the same location, plus aliases. */
export function apiFields<T extends FieldValues>(names: (Path<T> | false)[], aliases: Record<string, Path<T>> = {}): ApiFieldMap {
  const map: Record<string, string> = { ...aliases }
  for (const name of names) if (name) map[name] = name
  return map
}

/**
 * The form field an API error location belongs to: an exact match, else the
 * field of its parent object (e.g. "name.fr" at "name"). Never for items of a
 * list ("attributes[2].key"): those need their own entry.
 */
export function apiFieldFor(location: string, fields?: ApiFieldMap): string | undefined {
  if (!fields || !location.startsWith('body.')) return undefined
  const path = location.slice('body.'.length)
  if (Object.hasOwn(fields, path)) return fields[path]
  const top = path.split(/[.[]/)[0]
  if (path.startsWith(`${top}[`)) return undefined
  return Object.hasOwn(fields, top) ? fields[top] : undefined
}

/**
 * Shows an API error's per-field errors at the form's fields (see ApiFieldMap),
 * with their params. Returns how many were shown.
 */
export function setApiFieldErrors<T extends FieldValues>(error: unknown, setError: UseFormSetError<T>, fields: ApiFieldMap): number {
  if (!(error instanceof ApiError)) return 0
  const shown = error.fields.flatMap((field) => {
    const name = apiFieldFor(field.location, fields)
    return name ? [{ name, message: encode(knownError(field.code), knownError(field.code) === field.code ? field.params : undefined) }] : []
  })
  // Errors of whole lists last: react-hook-form keeps a list's item errors in
  // an array and adds the list's own error to it, not the other way round.
  shown.sort((a, b) => Number(a.name.endsWith('.root')) - Number(b.name.endsWith('.root')))
  for (const { name, message } of shown) setError(name as Path<T>, { type: 'server', message }, { shouldFocus: false })
  return shown.length
}

/**
 * An API error's per-field errors as react-hook-form errors (see
 * setApiFieldErrors), e.g. for useForm's `errors` option to show the problems
 * of loaded data from the start. Keep the result reference-stable.
 */
export function toFieldErrors<T extends FieldValues>(error: unknown, fields: ApiFieldMap): FieldErrors<T> {
  const result: Record<string, unknown> = {}
  const set = (name: string, value: object) => {
    const parts = name.split('.')
    let node = result
    for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>
    node[parts[parts.length - 1]] = value
  }
  setApiFieldErrors(error, ((name: string, value: object) => set(name, value)) as UseFormSetError<T>, fields)
  return result as FieldErrors<T>
}

/**
 * Moves focus to the first field with an error inside `container`, in page
 * order, and scrolls it into view. Error texts without a field of their own
 * (e.g. a list's error) are marked with data-field-error and tabIndex -1.
 */
export function focusFirstError(container: HTMLElement | null) {
  const target = container?.querySelector<HTMLElement>('[aria-invalid="true"], [data-field-error]')
  if (!target) return false
  target.focus({ preventScroll: true })
  target.scrollIntoView?.({ block: 'center' })
  return true
}
