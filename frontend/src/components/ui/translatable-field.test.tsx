import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import i18n from '@/i18n'

import { TranslatableField } from './translatable-field'
import { emptyTranslatable, fromTranslatable, optionalTranslatable, toTranslatable, type TranslatableValue } from './translatable'

function Harness({ initial, errors, disabled }: { initial: TranslatableValue; errors?: Record<string, string>; disabled?: boolean }) {
  const [value, setValue] = useState(initial)
  return (
    <fieldset disabled={disabled}>
      <TranslatableField label="Name" required value={value} onChange={setValue} errors={errors} />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </fieldset>
  )
}

const tabs = () => within(screen.getByRole('tablist', { name: 'Translations of Name' })).getAllByRole('tab')

describe('TranslatableField', () => {
  it('has a tab per language, opens on the UI language and edits the chosen one', async () => {
    const user = userEvent.setup()
    render(<Harness initial={{ en: 'Dimmer', de: '' }} />)

    expect(tabs().map((t) => t.textContent)).toEqual(['English*', 'German'])
    expect(screen.getByRole('tab', { name: 'English' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'English' })).toHaveAccessibleDescription('Filled in')
    expect(screen.getByRole('tab', { name: 'German' })).toHaveAccessibleDescription('Not translated yet')
    const input = screen.getByLabelText('Name')
    expect(input).toHaveValue('Dimmer')
    expect(input).toHaveAttribute('aria-required', 'true')
    expect(input).toHaveAttribute('lang', 'en')

    await user.click(screen.getByRole('tab', { name: 'German' }))
    // An empty translation shows what its readers get instead: the English text.
    expect(screen.getByLabelText('Name')).toHaveValue('')
    expect(screen.getByLabelText('Name')).toHaveAttribute('placeholder', 'Dimmer')
    expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-required')
    await user.type(screen.getByLabelText('Name'), 'Dimmaktor')
    expect(screen.getByTestId('value')).toHaveTextContent('{"en":"Dimmer","de":"Dimmaktor"}')
    expect(screen.getByRole('tab', { name: 'German' })).toHaveAccessibleDescription('Filled in')

    // Arrow keys move between the tabs.
    await user.keyboard('{Shift>}{Tab}{/Shift}{ArrowLeft}')
    expect(screen.getByRole('tab', { name: 'English' })).toHaveFocus()
    expect(screen.getByLabelText('Name')).toHaveValue('Dimmer')
  })

  it('opens on the German tab in the German UI', async () => {
    await i18n.changeLanguage('de')
    try {
      render(<Harness initial={{ en: 'Dimmer', de: 'Dimmaktor' }} />)
      expect(screen.getByRole('tab', { name: 'Deutsch' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('tab', { name: 'Englisch' })).toHaveAttribute('aria-selected', 'false')
      expect(screen.getByLabelText('Name')).toHaveValue('Dimmaktor')
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('shows the language with an error, marks its tab and keeps the others', () => {
    const { rerender } = render(<Harness initial={{ en: 'Dimmer', de: 'x' }} />)
    expect(screen.getByRole('tab', { name: 'English' })).toHaveAttribute('aria-selected', 'true')

    rerender(<Harness initial={{ en: 'Dimmer', de: 'x' }} errors={{ de: 'This value is too long.' }} />)
    expect(screen.getByRole('tab', { name: 'German' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'German' })).toHaveAccessibleDescription('Has an error')
    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription('This value is too long.')
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true')
  })

  it('lets read-only forms show every language', () => {
    render(<Harness initial={{ en: 'Dimmer', de: 'Dimmaktor' }} disabled />)
    expect(screen.getByLabelText('Name')).toBeDisabled()
    // A plain click: user-event treats everything inside a disabled fieldset as disabled, browsers only its controls.
    fireEvent.click(screen.getByRole('tab', { name: 'German' }))
    expect(screen.getByLabelText('Name')).toHaveValue('Dimmaktor')
  })
})

describe('translatable values', () => {
  it('convert from and to API texts', () => {
    expect(emptyTranslatable()).toEqual({ en: '', de: '' })
    expect(toTranslatable({ en: 'Dimmer' })).toEqual({ en: 'Dimmer', de: '' })
    expect(fromTranslatable({ en: 'Dimmer', de: ' ' })).toEqual({ en: 'Dimmer' })
    expect(fromTranslatable({ en: '', de: 'Dimmer' })).toEqual({ en: '', de: 'Dimmer' })
    expect(optionalTranslatable({ en: ' ', de: '' })).toBeUndefined()
  })
})
