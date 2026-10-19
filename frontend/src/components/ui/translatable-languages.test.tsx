import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'

import { server } from '@/test/server'

// A test-only content-locale list with a third language (the UI languages
// stay as they are): every translatable form derives its tabs, values, checks
// and API body from `contentLocales`, so adding a language needs no form
// changes (D109). This renders a real form (the function type dialog) with
// French added and nothing else changed.
vi.mock('@/i18n/content-locales', () => ({ contentLocales: ['en', 'de', 'fr'] }))

describe('a third language', () => {
  it('shows a third tab and sends its text, with no form changes', async () => {
    const { contentLocales } = await import('@/i18n/content-locales')
    expect(contentLocales).toEqual(['en', 'de', 'fr'])
    const { languages } = await import('@/i18n/resources')
    expect(languages).toEqual(['en', 'de'])
    const { FunctionTypeFormDialog } = await import('@/features/function-types/FunctionTypeFormDialog')
    const { renderWithProviders } = await import('@/test/render')

    let posted: unknown
    server.use(
      http.get('/api/load-types', () => HttpResponse.json({ items: [] })),
      http.post('/api/function-types', async ({ request }) => {
        posted = await request.json()
        return HttpResponse.json({}, { status: 201 })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<FunctionTypeFormDialog open onOpenChange={() => {}} functionType={null} />)

    const dialog = await screen.findByRole('dialog')
    const tablist = within(dialog).getByRole('tablist', { name: 'Translations of Name' })
    expect(within(tablist).getAllByRole('tab').map((t) => t.textContent)).toEqual(['English*', 'German', 'French'])

    await user.type(within(dialog).getByLabelText('Key'), 'dimmer')
    await user.type(within(dialog).getByLabelText('Name'), 'Dimmer')
    await user.click(within(tablist).getByRole('tab', { name: 'French' }))
    expect(within(dialog).getByLabelText('Name')).toHaveAttribute('placeholder', 'Dimmer')
    await user.type(within(dialog).getByLabelText('Name'), 'Variateur')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(posted).toEqual({ key: 'dimmer', name: { en: 'Dimmer', fr: 'Variateur' }, allowsCircuit: false, loadTypeIds: [], isActive: true, knxObjects: [] }))
  })
})
