// Focus targets of editor links (?focus=…, 4b-4).

/** The id of the zone inspector's template picker (focused by ?focus=template). */
export const templatePickerId = 'zone-apply-template'

/** Focuses an element once it is rendered (the inspector shows after the editor has loaded and locked), for up to 3 s. */
export function focusWhenShown(id: string, tries = 30) {
  const el = document.getElementById(id)
  if (el) {
    el.scrollIntoView?.({ block: 'center' })
    el.focus()
  } else if (tries > 0) window.setTimeout(() => focusWhenShown(id, tries - 1), 100)
}
