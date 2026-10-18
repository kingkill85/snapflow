import { useQueryClient } from '@tanstack/react-query'
import { LogOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavLink, Outlet, useNavigate } from 'react-router'

import { useLogout } from '@/api/generated/auth/auth'
import { Button, Select } from '@/components/ui'
import { languages } from '@/i18n/resources'
import { cn } from '@/lib/cn'

import { features } from './features'
import { useCan, useMe } from './session'

// The navigation groups features by section, in this order; within a
// section they keep the order of the features list (`make feature` appends).
const sectionOrder = ['catalog', 'projects', 'admin'] as const
const navFeatures = sectionOrder.flatMap((section) => features.filter((f) => f.nav?.section === section))

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn('rounded-control px-3 py-1.5 text-sm whitespace-nowrap', isActive ? 'bg-canvas font-medium' : 'text-muted hover:text-ink')

export function AppShell() {
  const { t, i18n } = useTranslation()
  const me = useMe()
  const can = useCan()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const logout = useLogout()

  const signOut = async () => {
    try {
      await logout.mutateAsync()
    } catch {
      // Signed out locally anyway; the session expires on its own.
    }
    // Forget everything cached for this user, even if the call failed.
    queryClient.clear()
    void navigate('/login', { replace: true })
  }

  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b border-line bg-surface">
        {/* Phones: brand and account on top, the navigation scrolls below. */}
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 px-4 sm:px-6 lg:h-14 lg:flex-nowrap lg:gap-x-6">
          <span className="flex h-14 items-center font-semibold lg:h-auto">{t('app.name')}</span>
          <nav className="order-last -mx-4 flex w-[calc(100%+2rem)] gap-1 overflow-x-auto border-t border-line px-4 py-2 sm:-mx-6 sm:w-[calc(100%+3rem)] sm:px-6 lg:order-none lg:mx-0 lg:w-auto lg:flex-1 lg:border-0 lg:p-0">
            {navFeatures
              .filter((f) => !f.permission || can(f.permission))
              .map((f) => (
                <NavLink key={f.path} to={`/${f.path}`} className={navLinkClass}>
                  {t(f.nav!.labelKey as never, { ns: f.nav!.namespace }) as string}
                </NavLink>
              ))}
          </nav>
          <div className="ml-auto flex min-w-0 items-center gap-2 lg:gap-4">
            <Select
              aria-label={t('language.label')}
              className="w-24 shrink-0 sm:w-28"
              value={i18n.resolvedLanguage}
              onChange={(e) => void i18n.changeLanguage(e.target.value)}
              options={languages.map((lng) => ({ value: lng, label: t(`language.${lng}`) }))}
            />
            <NavLink to="/profile" className={(state) => cn(navLinkClass(state), 'min-w-0 max-w-48')} title={t('account.profile')}>
              <span className="block truncate leading-tight">{me.fullName || me.email}</span>
              <span className="block truncate text-xs leading-tight text-muted">{me.tenantName}</span>
            </NavLink>
            <Button variant="ghost" size="sm" className="shrink-0 px-2 sm:px-3" title={t('action.signOut')} onClick={() => void signOut()}>
              <LogOut /> <span className="sr-only sm:not-sr-only">{t('action.signOut')}</span>
            </Button>
          </div>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  )
}
