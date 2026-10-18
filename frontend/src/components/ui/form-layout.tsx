import type { ComponentProps, ReactNode } from 'react'

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
 * view while scrolling. `error`: shown next to the buttons, e.g. ErrorMessage.
 */
export function FormActions({ error, children }: { error?: ReactNode; children: ReactNode }) {
  return (
    <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-canvas py-4">
      <div className="min-w-0 flex-1">{error}</div>
      {children}
    </div>
  )
}
