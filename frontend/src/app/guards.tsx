import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, Outlet, useLocation } from 'react-router'

import type { Permission } from '@/api/generated/model'
import { EmptyState, ErrorMessage, Loading, Page } from '@/components/ui'

import { features } from './features'
import { useCan, useSession } from './session'

/** Renders the child routes only for a logged-in user; others go to /login. */
export function RequireAuth() {
  const session = useSession()
  const location = useLocation()
  if (session.isPending) return <Loading />
  if (session.anonymous) {
    const returnTo = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?returnTo=${returnTo}`} replace />
  }
  if (!session.me) {
    return (
      <Page title="SnapFlow">
        <ErrorMessage error={session.error} />
      </Page>
    )
  }
  return <Outlet />
}

/** Shows children only with the permission, a notice otherwise. */
export function RequirePermission({ permission, children }: { permission?: Permission; children: ReactNode }) {
  const { t } = useTranslation()
  const can = useCan()
  if (permission && !can(permission)) {
    return (
      <Page title={t('state.forbiddenTitle')}>
        <EmptyState title={t('state.forbidden')} />
      </Page>
    )
  }
  return children
}

/** Sends the user to the first page they may see. */
export function Home() {
  const can = useCan()
  const first = features.find((f) => f.nav && (!f.permission || can(f.permission)))
  return <Navigate to={`/${first?.path ?? 'profile'}`} replace />
}
