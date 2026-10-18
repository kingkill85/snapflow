import { useSyncExternalStore } from 'react'

/** The colour theme: follow the system (prefers-color-scheme) or force light or dark. */
export type Theme = 'system' | 'light' | 'dark'
export const themes: readonly Theme[] = ['system', 'light', 'dark']

const storageKey = 'theme'
const listeners = new Set<() => void>()

const isTheme = (value: unknown): value is Theme => themes.includes(value as Theme)

/** The remembered choice; storage may be unavailable (private mode, blocked site data). */
function stored(): Theme {
  try {
    const value = window.localStorage.getItem(storageKey)
    return isTheme(value) ? value : 'system'
  } catch {
    return 'system'
  }
}

let current: Theme = 'system'

/** index.css switches the tokens on <html data-theme>; without it the system setting applies. */
function apply(theme: Theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.dataset.theme = theme
}

/** Applies the remembered theme; called once before the first render, so nothing flashes. */
export function initTheme() {
  current = stored()
  apply(current)
}

/** Applies and remembers a theme ("system" forgets the choice). */
export function setTheme(theme: Theme) {
  current = theme
  apply(theme)
  try {
    if (theme === 'system') window.localStorage.removeItem(storageKey)
    else window.localStorage.setItem(storageKey, theme)
  } catch {
    // Not remembered, but applied for this visit.
  }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The chosen theme and a setter, e.g. for the theme choice in the user menu. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, () => current)
  return [theme, setTheme]
}
