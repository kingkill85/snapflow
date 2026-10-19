import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/client'

import { type ApiFieldMap, apiFieldFor, type ErrorKey } from './form-errors'

/**
 * Translates an API error code into the user's language. `fields` are the
 * form fields that show per-field errors themselves (see setApiFieldErrors);
 * per-field errors without such a field are spelled out in the message.
 */
/** An RFC 3339 time as the API sends it (e.g. a lock's expiresAt). */
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/**
 * Params with times (RFC 3339) as localized text: the time of day for today
 * ("14:32"), else date and time. Other params stay as they are.
 */
export function formatTimeParams(params: Record<string, unknown> | undefined, language: string, now = new Date()) {
  if (!params) return params
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    const date = typeof value === 'string' && isoTime.test(value) ? new Date(value) : undefined
    if (!date || Number.isNaN(date.getTime())) {
      out[key] = value
      continue
    }
    const today = date.toDateString() === now.toDateString()
    out[key] = new Intl.DateTimeFormat(language, today ? { timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' }).format(date)
  }
  return out
}

export function useErrorMessage() {
  const { t, i18n } = useTranslation('errors')
  const translate = (code: string, params?: Record<string, unknown>) =>
    i18n.exists(code, { ns: 'errors' }) ? String(t(code as ErrorKey, formatTimeParams(params, i18n.resolvedLanguage ?? 'en') as never)) : undefined

  return (error: unknown, fields?: ApiFieldMap): string => {
    if (!(error instanceof ApiError)) return t('server.error')
    if (error.fields.length > 0) {
      const elsewhere = error.fields.filter((f) => !apiFieldFor(f.location, fields))
      // Every error is shown at its field.
      if (elsewhere.length === 0) return t('validation.failed')
      const messages = new Set(elsewhere.map((f) => translate(f.code, f.params) ?? t('validation.invalid')))
      if (elsewhere.length < error.fields.length) messages.add(t('validation.failed'))
      return [...messages].join(' ')
    }
    // "Check the highlighted fields" would be wrong with nothing highlighted.
    if (error.code === 'validation.failed') return t('request.bad')
    return translate(error.code, error.params) ?? t('server.error')
  }
}
