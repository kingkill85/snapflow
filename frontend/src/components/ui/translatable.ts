import { z } from 'zod'

import type { LocalizedText } from '@/i18n/localized'
import { type ContentLocale, contentLocales } from '@/i18n/content-locales'

import { type ApiFieldMap, errorKey } from './form-errors'

// Translatable texts (i18n.Text on the server) in forms: one string per
// language of `contentLocales` (the one list, checked against the backend's
// i18n.Locales), the first being the default that every text needs (D36,
// D109). Nothing here names a language, so adding one to `contentLocales` needs no
// form changes.

/** The language every translatable text must have (the backend's i18n.DefaultLocale). */
export const defaultLanguage: ContentLocale = contentLocales[0]

/** A translatable text in a form: every language, blank when not translated. */
export type TranslatableValue = Record<ContentLocale, string>

/** A translatable text with every language blank, e.g. for a new record. */
export const emptyTranslatable = (): TranslatableValue => Object.fromEntries(contentLocales.map((l) => [l, ''])) as TranslatableValue

/** An API text as form value: every language, missing ones blank. */
export const toTranslatable = (text?: LocalizedText): TranslatableValue =>
  Object.fromEntries(contentLocales.map((l) => [l, text?.[l] ?? ''])) as TranslatableValue

/** Whether no language has text. */
export const isBlankTranslatable = (value: TranslatableValue) => contentLocales.every((l) => value[l].trim() === '')

/** A form value as API text: the default language always, the others only when filled in. */
export const fromTranslatable = (value: TranslatableValue): LocalizedText =>
  Object.fromEntries(contentLocales.filter((l) => l === defaultLanguage || value[l].trim() !== '').map((l) => [l, value[l]]))

/** Like fromTranslatable, but nothing at all when every language is blank (an optional text). */
export const optionalTranslatable = (value: TranslatableValue): LocalizedText | undefined =>
  isBlankTranslatable(value) ? undefined : fromTranslatable(value)

type TranslatableSchemaOptions = {
  /** The server's limit per language, in characters. */
  max?: number
  /** The error when the default language is blank (a required text), e.g. errorKey('validation.required'). */
  required?: string
  /**
   * Whether a translation without the default language is an error (default
   * true). False where the form checks it itself, e.g. for list items only
   * sent for some types.
   */
  checkDefault?: boolean
}

/**
 * The zod schema of a translatable text: each language at most `max`
 * characters (when given); the default language is required when `required` is given, and
 * always once any other language is filled in (the server's rule, D36).
 */
export function translatableSchema({ max, required, checkDefault = true }: TranslatableSchemaOptions = {}) {
  const text = max === undefined ? z.string() : z.string().max(max, errorKey('validation.too_long', { max }))
  const shape = Object.fromEntries(contentLocales.map((l) => [l, text])) as Record<ContentLocale, z.ZodString>
  return z.object(shape).superRefine((value, ctx) => {
    if (value[defaultLanguage].trim() !== '') return
    if (required) ctx.addIssue({ code: 'custom', path: [defaultLanguage], message: required })
    else if (checkDefault && !isBlankTranslatable(value)) ctx.addIssue({ code: 'custom', path: [defaultLanguage], message: errorKey('validation.required') })
  })
}

/**
 * ApiFieldMap entries for a translatable text: the server's location of each
 * language (e.g. "name.de") at the form field's language (e.g. "name.de"), so
 * the error shows on that language's tab. `target` is the form path when it
 * differs, e.g. "attributes.2.label" for "attributes[2].label".
 */
export const translatableApiFields = (location: string, target: string = location): ApiFieldMap =>
  Object.fromEntries(contentLocales.map((l) => [`${location}.${l}`, `${target}.${l}`]))
