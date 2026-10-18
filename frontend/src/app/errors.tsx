import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { Button, EmptyState, Page } from '@/components/ui'

/** Shown for any URL without a page, e.g. SnapFlow 1 paths. */
export function NotFound() {
  const { t } = useTranslation()
  return (
    <Page title={t('state.notFoundTitle')}>
      <EmptyState
        title={t('state.notFound')}
        action={
          <Button asChild variant="secondary">
            <Link to="/">{t('action.home')}</Link>
          </Button>
        }
      />
    </Page>
  )
}

/** The router's last resort when rendering a page fails. */
export function RouteError() {
  const { t } = useTranslation()
  return (
    <Page title={t('state.errorTitle')}>
      <EmptyState
        title={t('state.error')}
        action={
          // A full page load: after an error the app state may be broken.
          <Button asChild variant="secondary">
            <a href="/">{t('action.home')}</a>
          </Button>
        }
      />
    </Page>
  )
}
