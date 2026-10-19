import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { getGetMeQueryKey } from '@/api/generated/auth/auth'
import i18n from '@/i18n'
import { setTheme } from '@/lib/theme'
import { tenantAdminMe, userMe } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { AppShell } from './AppShell'

const routes = (
  <Routes>
    <Route path="/login" element={<p>login page</p>} />
    <Route path="/" element={<AppShell />}>
      <Route index element={<p>home page</p>} />
      <Route path="*" element={<p>some page</p>} />
    </Route>
  </Routes>
)

afterEach(async () => {
  setTheme('system')
  await i18n.changeLanguage('en')
})

const mainNav = () => screen.getByRole('navigation', { name: 'Main navigation' })

/** The entries of a section menu, by opening it. */
async function sectionItems(user: ReturnType<typeof userEvent.setup>, section: string) {
  await user.click(within(mainNav()).getByRole('button', { name: section }))
  const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent)
  await user.keyboard('{Escape}')
  return items
}

async function openUserMenu(user: ReturnType<typeof userEvent.setup>, label = 'Account: Ada Admin') {
  await user.click(await screen.findByRole('button', { name: label }))
  return screen.findByRole('menu')
}

describe('AppShell', () => {
  it.each([
    ['succeeds', () => new HttpResponse(null, { status: 204 })],
    ['fails', () => HttpResponse.json({ status: 500, code: 'server.error' }, { status: 500 })],
  ])('signs out from the user menu, forgets the cache and goes to the login page when the call %s', async (_, respond) => {
    let called = false
    server.use(
      http.post('/api/auth/logout', () => {
        called = true
        return respond()
      }),
    )
    const user = userEvent.setup()
    const { client } = renderWithProviders(routes)

    const menu = await openUserMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Sign out' }))

    expect(await screen.findByText('login page')).toBeInTheDocument()
    expect(called).toBe(true)
    expect(client.getQueryData(getGetMeQueryKey())).toBeUndefined()
  })

  it('signs out everywhere from the user menu after asking', async () => {
    let called = false
    server.use(
      http.post('/api/auth/logout-all', () => {
        called = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(routes)

    const menu = await openUserMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: 'Sign out everywhere' }))
    const dialog = await screen.findByRole('dialog', { name: 'Sign out everywhere' })
    expect(called).toBe(false)
    await user.click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }))

    expect(await screen.findByText('login page')).toBeInTheDocument()
    expect(called).toBe(true)
  })

  it('groups the navigation into sections: catalog, then administration', async () => {
    const user = userEvent.setup()
    renderWithProviders(routes)

    expect(within(await screen.findByRole('navigation', { name: 'Main navigation' })).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Catalog',
      'Administration',
    ])
    expect(await sectionItems(user, 'Catalog')).toEqual(['Products', 'Categories', 'Product types', 'Function types', 'Fields', 'Output kinds', 'Load types', 'Import'])
    expect(await sectionItems(user, 'Administration')).toEqual(['Users', 'Tenants', 'Roles', 'Company profile'])
  })

  it('shows only what the role may open; a section with one page is a plain link', async () => {
    const user = userEvent.setup()
    renderWithProviders(routes, { me: tenantAdminMe })
    await screen.findByRole('navigation', { name: 'Main navigation' })
    expect(await sectionItems(user, 'Administration')).toEqual(['Users', 'Roles', 'Company profile'])
  })

  it('links a single page of a section directly', async () => {
    renderWithProviders(routes, { me: userMe })
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' })
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['Catalog'])
    expect(within(nav).getByRole('link', { name: 'Roles' })).toHaveAttribute('href', '/admin/roles')
  })

  it('marks the section of the current page', async () => {
    renderWithProviders(routes, { route: '/catalog/products/123' })
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' })
    expect(within(nav).getByRole('button', { name: 'Catalog' })).toHaveAttribute('aria-current', 'true')
    expect(within(nav).getByRole('button', { name: 'Administration' })).not.toHaveAttribute('aria-current')
  })

  it('switches language and theme in the user menu', async () => {
    const user = userEvent.setup()
    renderWithProviders(routes)

    let menu = await openUserMenu(user)
    expect(within(menu).getByRole('menuitemradio', { name: 'System' })).toBeChecked()
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Dark' }))
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark')
    expect(within(menu).getByRole('menuitemradio', { name: 'Dark' })).toBeChecked()

    await user.click(within(menu).getByRole('menuitemradio', { name: 'Deutsch' }))
    expect(await within(menu).findByRole('menuitemradio', { name: 'Dunkel' })).toBeChecked()
    await user.keyboard('{Escape}')

    menu = await openUserMenu(user, 'Konto: Ada Admin')
    expect(within(menu).getByRole('menuitem', { name: 'Abmelden' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Profil' })).toHaveAttribute('href', '/profile')
  })

  it('opens the navigation and account in a side sheet on phones', async () => {
    const user = userEvent.setup()
    renderWithProviders(routes)

    await user.click(await screen.findByRole('button', { name: 'Menu' }))
    const sheet = await screen.findByRole('dialog', { name: 'Menu' })
    expect(within(sheet).getByRole('region', { name: 'Catalog' })).toBeInTheDocument()
    expect(within(within(sheet).getByRole('region', { name: 'Administration' })).getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Users',
      'Tenants',
      'Roles',
      'Company profile',
    ])
    await user.click(within(sheet).getByRole('link', { name: 'Products' }))
    expect(await screen.findByText('some page')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Menu' })).not.toBeInTheDocument()
  })
})
