import type { ParseKeys } from 'i18next'
import i18next from 'i18next'
import type { FieldValues, Path, UseFormSetError } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/client'

/** A key of the errors namespace, e.g. "validation.required". */
export type ErrorKey = ParseKeys<'errors'>

/**
 * Marks an error key used as a form message, e.g. in a zod schema:
 * `z.string().min(1, errorKey('validation.required'))`. A typo is a type error.
 */
export const errorKey = (key: ErrorKey): ErrorKey => key

const knownError = (code: string): ErrorKey => (i18next.exists(code, { ns: 'errors' }) ? (code as ErrorKey) : 'validation.invalid')

/** Translates a form field's error message (an error key from zod or the API). */
export function useFieldError() {
  const { t } = useTranslation('errors')
  return (message?: string): string | undefined => (message ? String(t(knownError(message))) : undefined)
}

/**
 * Which API field locations (below "body.") a form shows at which of its fields,
 * e.g. { email: 'email', 'name.en': 'nameEn' }. List only fields the form renders,
 * so an error is never reported as "highlighted" without a visible field.
 */
export type ApiFieldMap = Readonly<Record<string, string>>

/** Builds an ApiFieldMap: each named field at the same location, plus aliases. */
export function apiFields<T extends FieldValues>(names: (Path<T> | false)[], aliases: Record<string, Path<T>> = {}): ApiFieldMap {
  const map: Record<string, string> = { ...aliases }
  for (const name of names) if (name) map[name] = name
  return map
}

/** The form field an API error location belongs to: exact match first, then its top-level field. */
export function apiFieldFor(location: string, fields?: ApiFieldMap): string | undefined {
  if (!fields || !location.startsWith('body.')) return undefined
  const path = location.slice('body.'.length)
  if (Object.hasOwn(fields, path)) return fields[path]
  const top = path.split(/[.[]/)[0]
  return Object.hasOwn(fields, top) ? fields[top] : undefined
}

/** Shows an API error's per-field errors at the form's fields (see ApiFieldMap). */
export function setApiFieldErrors<T extends FieldValues>(error: unknown, setError: UseFormSetError<T>, fields: ApiFieldMap) {
  if (!(error instanceof ApiError)) return
  for (const field of error.fields) {
    const name = apiFieldFor(field.location, fields)
    if (name) setError(name as Path<T>, { type: 'server', message: knownError(field.code) }, { shouldFocus: false })
  }
}
