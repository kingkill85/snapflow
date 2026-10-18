import { type ReactNode, useId } from 'react'

type SectionProps = {
  title: string
  description?: string
  /** Buttons in the section's header, e.g. "Add variant". */
  actions?: ReactNode
  children: ReactNode
}

/** A titled card that groups related content on a page, e.g. one form. */
export function Section({ title, description, actions, children }: SectionProps) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="space-y-4 rounded-control border border-line bg-surface p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          {description && <p className="text-sm text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

/** The buttons at the end of a section's form, right-aligned above a divider, the same in every section. */
export function SectionActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">{children}</div>
}
