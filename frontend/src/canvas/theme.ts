import { useEffect, useState } from 'react'

/** Design tokens the canvas draws with (canvas needs colour values, not classes). */
export type CanvasTheme = {
  primary: string
  danger: string
  warning: string
  surface: string
  ink: string
  muted: string
  line: string
  canvas: string
}

const fallback: CanvasTheme = {
  primary: '#3b6fe0',
  danger: '#c0392b',
  warning: '#a6761d',
  surface: '#ffffff',
  ink: '#1f2430',
  muted: '#6b7280',
  line: '#e5e7eb',
  canvas: '#fafafa',
}

/**
 * Colours of what is drawn on the plan image (labels, markers, hatching,
 * handles): the light theme's, in dark mode too. A floorplan is a light
 * document whatever the UI theme, and the PNG export must not depend on it (D221).
 */
export const paperColors: Pick<CanvasTheme, 'primary' | 'danger' | 'warning' | 'surface' | 'ink' | 'muted'> = {
  primary: fallback.primary,
  danger: fallback.danger,
  warning: fallback.warning,
  surface: fallback.surface,
  ink: fallback.ink,
  muted: fallback.muted,
}

function read(): CanvasTheme {
  if (typeof window === 'undefined') return fallback
  const style = getComputedStyle(document.documentElement)
  const token = (name: keyof CanvasTheme) => style.getPropertyValue(`--color-${name}`).trim() || fallback[name]
  return {
    primary: token('primary'),
    danger: token('danger'),
    warning: token('warning'),
    surface: token('surface'),
    ink: token('ink'),
    muted: token('muted'),
    line: token('line'),
    canvas: token('canvas'),
  }
}

/** The current token colours; follows theme switches (data-theme and the system preference). */
export function useCanvasTheme(): CanvasTheme {
  const [theme, setTheme] = useState(read)
  useEffect(() => {
    const update = () => setTheme(read())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    media?.addEventListener?.('change', update)
    return () => {
      observer.disconnect()
      media?.removeEventListener?.('change', update)
    }
  }, [])
  return theme
}
