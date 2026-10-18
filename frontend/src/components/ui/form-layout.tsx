import { type ComponentProps, type ReactNode, useLayoutEffect, useRef } from 'react'

/**
 * Groups a form's controls; `disabled` disables every control inside, e.g. to
 * show a form read-only to users who may not change it.
 */
export function Fieldset({ disabled, children, ...props }: Omit<ComponentProps<'fieldset'>, 'className'>) {
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-6" {...props}>
      {children}
    </fieldset>
  )
}

/**
 * The action bar at the end of a page-sized form (Cancel + submit), kept in
 * view while scrolling: a floating bar with its own raised surface, as wide as
 * the sections (content scrolling underneath is covered, not cut off). Its
 * height (it grows when an error wraps, e.g. on a phone) is measured into
 * --form-actions-height, which the page keeps free for focus and error jumps
 * (scroll-padding-bottom, index.css), so a focused field is never under it.
 * `error`: shown next to the buttons, e.g. ErrorMessage.
 */
export function FormActions({ error, children }: { error?: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const bar = ref.current
    const root = document.documentElement
    if (!bar) return
    const measure = () => root.style.setProperty('--form-actions-height', `${bar.offsetHeight}px`)
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(bar)
    return () => {
      observer?.disconnect()
      root.style.removeProperty('--form-actions-height')
    }
  }, [])
  return (
    <div
      ref={ref}
      data-form-actions
      className="sticky bottom-3 z-10 flex flex-wrap items-center justify-end gap-2 rounded-control border border-edge bg-raised/95 px-4 py-3 shadow-lg backdrop-blur-sm"
    >
      <div className="min-w-0 flex-1 empty:hidden">{error}</div>
      {children}
    </div>
  )
}
