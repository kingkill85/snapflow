import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import type { Letterhead } from '@/api/generated/model'
import { problem } from '@/features/projects/test-fixtures'
import { tenantAdminMe } from '@/test/fixtures'
import { renderWithProviders } from '@/test/render'
import { server } from '@/test/server'

import { CompanyProfilePage } from './CompanyProfilePage'

const saved: Letterhead = {
  companyName: 'Acme Smart Homes',
  address: 'Main Street 1\n12345 Town',
  phone: '+49 1',
  email: 'info@acme.test',
  website: 'acme.test',
  logoFileId: null,
  logoUrl: null,
}

describe('CompanyProfilePage', () => {
  it('edits the own tenant letterhead with a logo (tenant admin)', async () => {
    let put: unknown
    let gets = 0
    server.use(
      http.get('/api/tenants/:id/letterhead', ({ params }) => {
        gets++
        expect(params.id).toBe(tenantAdminMe.tenantId)
        return HttpResponse.json(saved)
      }),
      http.post('/api/tenants/:id/logo', () =>
        HttpResponse.json({ id: 'logo-1', url: '/api/files/logo-1', contentType: 'image/png', size: 10, sha256: 'x', createdAt: '2026-10-19T10:00:00Z' }, { status: 201 }),
      ),
      http.put('/api/tenants/:id/letterhead', async ({ request }) => {
        put = await request.json()
        return HttpResponse.json({ ...(put as Letterhead), logoUrl: '/api/files/logo-1' })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<CompanyProfilePage />, { me: tenantAdminMe })
    const name = await screen.findByRole('textbox', { name: 'Company name' })
    expect(name).toHaveValue('Acme Smart Homes')
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue('Main Street 1\n12345 Town')
    expect(gets).toBe(1)

    await user.clear(name)
    await user.type(name, 'Acme GmbH')
    const file = new File(['png'], 'logo.png', { type: 'image/png' })
    await user.upload(screen.getByLabelText('Logo'), file)
    expect(await screen.findByRole('img', { name: 'Logo' })).toHaveAttribute('src', '/api/files/logo-1')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Letterhead saved.')).toBeInTheDocument()
    expect(put).toEqual({ companyName: 'Acme GmbH', address: 'Main Street 1\n12345 Town', phone: '+49 1', email: 'info@acme.test', website: 'acme.test', logoFileId: 'logo-1' })
  })

  it('checks the email and shows API field errors', async () => {
    server.use(
      http.get('/api/tenants/:id/letterhead', () => HttpResponse.json(saved)),
      http.put('/api/tenants/:id/letterhead', () =>
        problem(422, { code: 'validation.failed', fields: [{ location: 'body.website', code: 'validation.too_long', params: { max: 200 } }] }),
      ),
    )
    const user = userEvent.setup()
    renderWithProviders(<CompanyProfilePage />, { me: tenantAdminMe })
    const email = await screen.findByRole('textbox', { name: 'Email' })
    await user.clear(email)
    await user.type(email, 'not-an-email')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/valid email/i)).toBeInTheDocument()

    await user.clear(email)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Website' })).toHaveAttribute('aria-invalid', 'true'))
  })
})
