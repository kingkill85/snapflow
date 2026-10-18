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
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <span className="font-semibold">{t('app.name')}</span>
          <nav className="flex flex-1 gap-1 overflow-x-auto">
            {features
              .filter((f) => f.nav && (!f.permission || can(f.permission)))
              .map((f) => (
                <NavLink key={f.path} to={`/${f.path}`} className={navLinkClass}>
                  {t(f.nav!.labelKey as never, { ns: f.nav!.namespace }) as string}
                </NavLink>
              ))}
          </nav>
          <Select
            aria-label={t('language.label')}
            className="w-28"
            value={i18n.resolvedLanguage}
            onChange={(e) => void i18n.changeLanguage(e.target.value)}
            options={languages.map((lng) => ({ value: lng, label: t(`language.${lng}`) }))}
          />
          <NavLink to="/profile" className={navLinkClass} title={t('account.profile')}>
            <span className="block leading-tight">{me.fullName || me.email}</span>
            <span className="block text-xs leading-tight text-muted">{me.tenantName}</span>
          </NavLink>
          <Button variant="ghost" size="sm" onClick={() => void signOut()}>
            <LogOut /> {t('action.signOut')}
          </Button>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  )
}
