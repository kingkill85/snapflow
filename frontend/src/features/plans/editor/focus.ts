// Focus targets of editor links (?focus=…, 4b-4).

/** The id of the zone inspector's template picker (focused by ?focus=template). */
export const templatePickerId = 'zone-apply-template'

/**
 * Focuses an element once it is rendered (the inspector shows after the editor has loaded and locked), trying for
 * up to 3 s. Returns a function that stops trying (call it on unmount).
 */
export function focusWhenShown(id: string, tries = 30): () => void {
  let timer: number | undefined
  const attempt = (left: number) => {
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView?.({ block: 'center' })
      el.focus()
    } else if (left > 0) timer = window.setTimeout(() => attempt(left - 1), 100)
  }
  attempt(tries)
  return () => window.clearTimeout(timer)
}
