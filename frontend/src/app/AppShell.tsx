import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, LogOut, Menu as MenuIcon, UserRound } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router'

import { useLogout } from '@/api/generated/auth/auth'
import {
  Button,
  IconButton,
  Menu,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuSeparator,
  Select,
  Sheet,
  SheetGroup,
} from '@/components/ui'
import { SignOutEverywhereDialog } from '@/features/auth'
import { languages } from '@/i18n/resources'
import { cn } from '@/lib/cn'
import { type Theme, themes, useTheme } from '@/lib/theme'

import type { FeatureModule } from './feature'
import { features } from './features'
import { useCan, useMe } from './session'

// The navigation groups features by section, in this order (D97); within a
// section by `nav.order`, then in the order of the features list.
const sectionOrder = ['projects', 'catalog', 'admin'] as const
type Section = (typeof sectionOrder)[number]

type NavItem = { path: string; label: string }
type NavSection = { section: Section; label: string; items: NavItem[] }

const byOrder = (a: FeatureModule, b: FeatureModule) => (a.nav?.order ?? Infinity) - (b.nav?.order ?? Infinity)

/** The sections with the pages this user may open; empty sections are left out. */
function useNavSections(): NavSection[] {
  const { t } = useTranslation()
  const can = useCan()
  return sectionOrder
    .map((section) => ({
      section,
      label: t(`nav.${section}`),
      items: features
        .filter((f) => f.nav?.section === section && (!f.permission || can(f.permission)))
        .sort(byOrder)
        .map((f) => ({ path: `/${f.path}`, label: t(f.nav!.labelKey as never, { ns: f.nav!.namespace }) as string })),
    }))
    .filter((s) => s.items.length > 0)
}

const isWithin = (pathname: string, path: string) => pathname === path || pathname.startsWith(`${path}/`)

const navEntryClass = (active: boolean) =>
  cn('rounded-control px-3 py-1.5 text-sm font-normal whitespace-nowrap', active ? 'bg-canvas font-medium text-ink' : 'text-muted hover:text-ink')

export function AppShell() {
  const { t, i18n } = useTranslation()
  const me = useMe()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const logout = useLogout()
  const sections = useNavSections()
  const [theme, setTheme] = useTheme()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [confirmingSignOutAll, setConfirmingSignOutAll] = useState(false)

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

  const name = me.fullName || me.email
  const languageOptions = languages.map((lng) => ({ value: lng, label: t(`language.${lng}`) }))
  const themeOptions = themes.map((th) => ({ value: th, label: t(`theme.${th}`) }))
  const language = i18n.resolvedLanguage ?? 'en'
  const changeLanguage = (lng: string) => void i18n.changeLanguage(lng)
  const changeTheme = (th: string) => setTheme(th as Theme)

  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-[96rem] items-center gap-4 px-4 sm:px-6 lg:gap-6">
          <Link to="/" className="font-semibold whitespace-nowrap">
            {t('app.name')}
          </Link>

          {/* From 768 px: one entry per section; a section with several pages is a menu. */}
          <nav aria-label={t('nav.main')} className="hidden min-w-0 flex-1 items-center gap-1 md:flex">
            {sections.map((s) => {
              const active = s.items.some((item) => isWithin(pathname, item.path))
              if (s.items.length === 1) {
                const [item] = s.items
                return (
                  <NavLink key={s.section} to={item.path} className={({ isActive }) => navEntryClass(isActive)}>
                    {item.label}
                  </NavLink>
                )
              }
              return (
                <Menu
                  key={s.section}
                  label={s.label}
                  trigger={
                    <Button variant="ghost" size="sm" className={navEntryClass(active)} aria-current={active ? 'true' : undefined}>
                      {s.label}
                      <ChevronDown />
                    </Button>
                  }
                >
                  {s.items.map((item) => (
                    <MenuItem key={item.path} asChild active={isWithin(pathname, item.path)}>
                      <Link to={item.path}>{item.label}</Link>
                    </MenuItem>
                  ))}
                </Menu>
              )
            })}
          </nav>

          <div className="ml-auto hidden md:block">
            <Menu
              align="end"
              label={t('account.menu', { name })}
              trigger={
                <Button variant="ghost" className="h-10 max-w-64 gap-2 px-2" aria-label={t('account.menu', { name })}>
                  <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {name.charAt(0).toUpperCase()}
                  </span>
                  <span className="hidden min-w-0 text-left lg:block">
                    <span className="block truncate text-sm leading-tight">{name}</span>
                    <span className="block truncate text-xs leading-tight font-normal text-muted">{me.tenantName}</span>
                  </span>
                  <ChevronDown className="text-muted" />
                </Button>
              }
            >
              <MenuLabel>
                <span className="block truncate text-sm text-ink">{name}</span>
                <span className="block truncate font-normal">{me.tenantName}</span>
              </MenuLabel>
              <MenuSeparator />
              <MenuItem asChild active={isWithin(pathname, '/profile')}>
                <Link to="/profile">
                  <UserRound /> {t('account.profile')}
                </Link>
              </MenuItem>
              <MenuSeparator />
              <MenuLabel>{t('language.label')}</MenuLabel>
              <MenuRadioGroup value={language} onValueChange={changeLanguage} options={languageOptions} />
              <MenuSeparator />
              <MenuLabel>{t('theme.label')}</MenuLabel>
              <MenuRadioGroup value={theme} onValueChange={changeTheme} options={themeOptions} />
              <MenuSeparator />
              <MenuItem onSelect={() => setConfirmingSignOutAll(true)}>
                <LogOut /> {t('action.signOutEverywhere')}
              </MenuItem>
              <MenuItem onSelect={() => void signOut()}>
                <LogOut /> {t('action.signOut')}
              </MenuItem>
            </Menu>
          </div>

          {/* Phones: everything in a side sheet. */}
          <IconButton className="ml-auto md:hidden" label={t('nav.menu')} icon={<MenuIcon />} onClick={() => setSheetOpen(true)} />
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen} title={t('nav.menu')} closeLabel={t('action.close')}>
            <nav aria-label={t('nav.main')} className="space-y-6">
              {sections.map((s) => (
                <SheetGroup key={s.section} title={s.label}>
                  {s.items.map((item) => (
                    <NavLink
                      key={item.path}
                      to={item.path}
                      onClick={() => setSheetOpen(false)}
                      className={({ isActive }) => cn('block', navEntryClass(isActive))}
                    >
                      {item.label}
                    </NavLink>
                  ))}
                </SheetGroup>
              ))}
            </nav>
            <SheetGroup title={t('account.title')}>
              <div className="px-3 py-1.5">
                <span className="block truncate text-sm">{name}</span>
                <span className="block truncate text-xs text-muted">{me.tenantName}</span>
              </div>
              <NavLink to="/profile" onClick={() => setSheetOpen(false)} className={({ isActive }) => cn('block', navEntryClass(isActive))}>
                {t('account.profile')}
              </NavLink>
              <div className="space-y-3 px-3 pt-2">
                <Select aria-label={t('language.label')} value={language} onValueChange={changeLanguage} options={languageOptions} />
                <Select aria-label={t('theme.label')} value={theme} onValueChange={changeTheme} options={themeOptions} />
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => {
                    setSheetOpen(false)
                    setConfirmingSignOutAll(true)
                  }}
                >
                  <LogOut /> {t('action.signOutEverywhere')}
                </Button>
                <Button variant="secondary" className="w-full" onClick={() => void signOut()}>
                  <LogOut /> {t('action.signOut')}
                </Button>
              </div>
            </SheetGroup>
          </Sheet>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <SignOutEverywhereDialog open={confirmingSignOutAll} onOpenChange={setConfirmingSignOutAll} />
    </div>
  )
}
