/**
 * For a dialog's `onEscapeKeyDown`: Escape in an open combobox closes its
 * list, not the dialog. Radix catches Escape on the document before the
 * input sees it, so the combobox cannot stop it itself.
 */
export function keepDialogOnComboboxEscape(e: globalThis.KeyboardEvent) {
  const target = e.target
  if (target instanceof HTMLElement && target.getAttribute('role') === 'combobox' && target.getAttribute('aria-expanded') === 'true') e.preventDefault()
}
