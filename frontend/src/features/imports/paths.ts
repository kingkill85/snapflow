import type { QueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/client'
import { getListImportsQueryKey, getListImportTargetsQueryKey } from '@/api/generated/imports/imports'

export const listPath = '/catalog/imports'
export const newPath = `${listPath}/new`
export const runPath = (id: string) => `${listPath}/${id}`

export const productHref = (id: string) => `/catalog/products/${id}`
export const variantHref = (productId: string, variantId: string) => `/catalog/products/${productId}/variants/${variantId}`
export const categoryHref = (id: string) => `/catalog/categories/${id}`

/** The largest file the API takes (D124): checked here only to spare a long upload. */
export const maxFileMb = 50
export const acceptedExtensions = ['.xlsx', '.csv']

/** The error the server would give for this file, if it is obviously wrong (D124); the server decides. */
export function checkImportFile(file: File): ApiError | undefined {
  const name = file.name.toLowerCase()
  if (!acceptedExtensions.some((ext) => name.endsWith(ext))) return new ApiError({ status: 415, code: 'import.file_type' })
  if (file.size > maxFileMb * 1024 * 1024) return new ApiError({ status: 413, code: 'import.too_large', params: { maxMb: maxFileMb } })
  return undefined
}

/** Rows per page of the runs, the diff, the issues and the change log. */
export const pageSize = 50

/**
 * The search parameter of a new run's page with the profile chosen with the
 * upload: the page loads it and previews with it at once, and removes it once
 * that preview settled (D136).
 */
export const profileParam = 'profile'

/** Everything a run's page shows below the run itself: its items, issues, changes and source. */
export async function invalidateRunDetails(queryClient: QueryClient, id: string) {
  await Promise.all([
    queryClient.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith(`/api/imports/${id}/`) }),
    queryClient.invalidateQueries({ queryKey: getListImportsQueryKey() }),
    // Categories the run created (or removed again) have attributes to map.
    queryClient.invalidateQueries({ queryKey: getListImportTargetsQueryKey() }),
  ])
}

/** A date and time in the UI language, e.g. "18 Oct 2026, 14:05". */
export function useFormatDateTime() {
  const { i18n } = useTranslation()
  const format = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', { dateStyle: 'medium', timeStyle: 'short' })
  return (value?: string) => (value ? format.format(new Date(value)) : '')
}

/** A file size in the UI language, e.g. "1.2 MB". */
export function useFormatBytes() {
  const { i18n } = useTranslation()
  return (bytes: number) => {
    const mb = bytes / (1024 * 1024)
    const format = new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en', { maximumFractionDigits: mb < 10 ? 1 : 0 })
    return mb >= 0.1 ? `${format.format(mb)} MB` : `${format.format(Math.max(1, Math.round(bytes / 1024)))} KB`
  }
}
