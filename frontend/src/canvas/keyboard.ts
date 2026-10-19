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
