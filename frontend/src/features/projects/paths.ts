import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/client'

export const listPath = '/projects'
export const projectPath = (id: string) => `${listPath}/${id}`
export const versionPath = (projectId: string, versionId: string) => `${projectPath(projectId)}/versions/${versionId}`

/** Forms never start from cached data (D44): fetched on every visit, never refreshed underneath the form. */
export const fresh = { staleTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: false } as const

/** A missing record, or an id that is not one (422 at path.*). */
export const isNotFound = (error: unknown) =>
  error instanceof ApiError && (error.status === 404 || (error.status === 422 && error.fields.some((f) => f.location.startsWith('path.'))))

/** A date in the UI language, e.g. "18 Oct 2026". */
export function useFormatDate() {
  const { i18n } = useTranslation()
  const format = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', { dateStyle: 'medium' })
  return (value: string) => format.format(new Date(value))
}
