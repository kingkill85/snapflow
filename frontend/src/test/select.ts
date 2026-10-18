import { screen } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'

/** Opens a design-system Select (its trigger, e.g. from getByLabelText) and picks the option with that name. */
export async function chooseOption(user: UserEvent, trigger: HTMLElement, name: string | RegExp) {
  await user.click(trigger)
  await user.click(await screen.findByRole('option', { name }))
}

/** The option texts a Select offers; opens it and closes it again with Escape. */
export async function optionTexts(user: UserEvent, trigger: HTMLElement): Promise<string[]> {
  await user.click(trigger)
  const texts = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '')
  await user.keyboard('{Escape}')
  return texts
}
