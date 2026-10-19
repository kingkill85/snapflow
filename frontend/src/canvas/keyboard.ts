/** Whether a key event comes from a place where the user types (shortcuts must not fire there). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type)
  }
  // Radix Select triggers and listboxes take keys too.
  return target.closest('[role="listbox"],[role="combobox"],[role="dialog"]') !== null
}

/** Ctrl on Windows/Linux, Cmd on macOS. */
export const isModKey = (e: { ctrlKey: boolean; metaKey: boolean }) => e.ctrlKey || e.metaKey

/** Elements that use plain keys themselves (Space, arrows, Delete, Backspace): the canvas must not take them there. */
const interactiveSelector = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="slider"]',
  '[role="listbox"]',
  '[role="combobox"]',
  '[role="menu"]',
  '[role="dialog"]',
].join(',')

/**
 * Whether a plain key (Space, arrows, Delete, Backspace) may act on the
 * canvas: only when focus is on the page itself, the canvas container or
 * another non-interactive element, never on a control (a focused button,
 * switch, tab, checkbox, field, ...) that uses the key itself.
 */
export function isCanvasKeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true
  if (target instanceof HTMLElement && target.isContentEditable) return false
  return target.closest(interactiveSelector) === null
}
