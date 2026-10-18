import { NavLink, Outlet } from 'react-router'
import { useTranslation } from 'react-i18next'

import { languages } from '@/i18n/resources'
import { cn } from '@/lib/cn'

import { features } from './features'

export function AppShell() {
  const { t, i18n } = useTranslation()
  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <span className="font-semibold">{t('app.name')}</span>
          <nav className="flex flex-1 gap-1 overflow-x-auto">
            {features
              .filter((f) => f.nav)
              .map((f) => (
                <NavLink
                  key={f.path}
                  to={`/${f.path}`}
                  className={({ isActive }) =>
                    cn('rounded-control px-3 py-1.5 text-sm whitespace-nowrap', isActive ? 'bg-canvas font-medium' : 'text-muted hover:text-ink')
                  }
                >
                  {t(f.nav!.labelKey as never, { ns: f.nav!.namespace }) as string}
                </NavLink>
              ))}
          </nav>
          <label className="flex items-center gap-2 text-sm text-muted">
            <span className="sr-only">{t('language.label')}</span>
            <select
              className="rounded-control border border-line bg-surface px-2 py-1 text-ink"
              value={i18n.resolvedLanguage}
              onChange={(e) => void i18n.changeLanguage(e.target.value)}
            >
              {languages.map((lng) => (
                <option key={lng} value={lng}>
                  {t(`language.${lng}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  )
}
