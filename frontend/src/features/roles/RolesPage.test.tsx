import { screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { RoleMatrix } from '@/api/generated/model'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { RolesPage } from './RolesPage'

const matrix: RoleMatrix = {
  permissions: ['catalog.read', 'catalog.write'],
  roles: [
    { role: 'admin', permissions: ['catalog.read', 'catalog.write'] },
    { role: 'user', permissions: ['catalog.read'] },
  ],
}

describe('RolesPage', () => {
  it('shows the permission matrix', async () => {
    server.use(http.get('/api/roles', () => HttpResponse.json(matrix)))
    renderWithProviders(<RolesPage />)

    const write = (await screen.findByText('Edit catalog')).closest('tr')!
    const cells = within(write).getAllByRole('cell')
    expect(within(cells[1]).getByLabelText('Allowed')).toBeInTheDocument()
    expect(within(cells[2]).getByLabelText('Not allowed')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'User' })).toBeInTheDocument()
  })
})
