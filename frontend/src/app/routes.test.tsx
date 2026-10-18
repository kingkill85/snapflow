import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderRoutes } from '@/test/render'

import { routes } from './routes'

describe('routes', () => {
  it('shows a not-found page inside the shell for unknown paths', async () => {
    renderRoutes(routes, { route: '/settings/users' })

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to start page' })).toHaveAttribute('href', '/')
  })
})
