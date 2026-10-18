import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/client'

/** Translates an API error code into the user's language. */
export function useErrorMessage() {
  const { t, i18n } = useTranslation('errors')
  return (error: unknown): string => {
    if (!(error instanceof ApiError)) return t('server.error')
    if (i18n.exists(error.code, { ns: 'errors' })) {
      return String(t(error.code as never, error.params as never))
    }
    return t('server.error')
  }
}
