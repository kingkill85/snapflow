import { within } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'

/** A language's tab name in the English UI, e.g. "German" for "de". */
export const languageName = (language: string) => new Intl.DisplayNames(['en'], { type: 'language' }).of(language) ?? language

/** The TranslatableField labelled `label` in `scope` (the first, e.g. a row's own before its options'). */
export function translatableField(scope: HTMLElement, label: string): HTMLElement {
  const tablist = within(scope).getAllByRole('tablist', { name: `Translations of ${label}` })[0]
  return tablist.closest<HTMLElement>('[data-translatable]')!
}

/** The language a TranslatableField shows (its selected tab's name), and that language's input, without clicking. */
export function shownTranslation(scope: HTMLElement, label: string): { language: string; input: HTMLElement } {
  const field = translatableField(scope, label)
  const tab = within(field).getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')!
  return { language: tab.textContent?.replace('*', '') ?? '', input: within(field).getByLabelText(label) }
}

/**
 * Shows one language of a TranslatableField (clicks its tab, unless it is
 * shown already) and returns that language's input, e.g.
 * `await user.type(await translation(user, dialog, 'Name', 'de'), 'Dimmer')`.
 */
export async function translation(user: UserEvent, scope: HTMLElement, label: string, language: string): Promise<HTMLElement> {
  // Waits for the field, e.g. while the editor loads.
  const tablist = (await within(scope).findAllByRole('tablist', { name: `Translations of ${label}` }))[0]
  const field = tablist.closest<HTMLElement>('[data-translatable]')!
  const tab = within(field).getByRole('tab', { name: languageName(language) })
  if (tab.getAttribute('aria-selected') !== 'true') await user.click(tab)
  return within(field).getByLabelText(label)
}
