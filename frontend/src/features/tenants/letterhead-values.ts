import { z } from 'zod'

import type { Letterhead, LetterheadInput } from '@/api/generated/model'
import { type ApiFieldMap, errorKey } from '@/components/ui'

const text = (max: number) => z.string().trim().max(max, errorKey('validation.too_long', { max }))

/** The letterhead fields of a form (D261); the API checks them again. */
export const letterheadSchema = z.object({
  companyName: text(200),
  address: text(500),
  phone: text(50),
  email: z.union([z.literal(''), z.email(errorKey('validation.email'))]),
  website: text(200),
  logoFileId: z.string().nullable(),
  /** The preview of the logo; not sent. */
  logoUrl: z.string().nullable(),
})
export type LetterheadValues = z.infer<typeof letterheadSchema>

export const toLetterheadValues = (l: Letterhead): LetterheadValues => ({
  companyName: l.companyName,
  address: l.address,
  phone: l.phone,
  email: l.email,
  website: l.website,
  logoFileId: l.logoFileId,
  logoUrl: l.logoUrl,
})

/** The PUT body: every field, as PUT replaces the letterhead. */
export const toLetterheadInput = ({ logoUrl: _preview, ...v }: LetterheadValues): LetterheadInput => v

const names = ['companyName', 'address', 'phone', 'email', 'website', 'logoFileId'] as const

/** The API's field locations at the form's fields, the letterhead under `prefix` ("letterhead." in the tenant dialog). */
export const letterheadApiFields = (prefix = ''): ApiFieldMap => Object.fromEntries(names.map((n) => [n, `${prefix}${n}`]))

