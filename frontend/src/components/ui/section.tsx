import { createContext, type ReactNode, useContext, useId } from 'react'

/** Inside a SectionGroup the sections' titles are one level lower (h3 under the group's h2). */
const NestedContext = createContext(false)

type SectionProps = {
  title: string
  description?: string
  /** Buttons in the section's header, e.g. "Add variant". */
  actions?: ReactNode
  /** For links to the section (the URL's hash). */
  id?: string
  children: ReactNode
}

/** A titled card that groups related content on a page, e.g. one form. */
export function Section({ title, description, actions, id, children }: SectionProps) {
  const titleId = useId()
  const Heading = useContext(NestedContext) ? 'h3' : 'h2'
  return (
    <section id={id} aria-labelledby={titleId} className="scroll-mt-4 space-y-4 rounded-control border border-line bg-surface p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <Heading id={titleId} className="text-base font-semibold">
            {title}
          </Heading>
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

/**
 * Sections for one audience or purpose under a heading with one line, e.g. the Documents tab's "For the customer" and
 * "For the installer" (D450). The sections inside get h3 titles.
 */
export function SectionGroup({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="space-y-4">
      <div className="space-y-1">
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        {description && <p className="text-sm text-muted">{description}</p>}
      </div>
      <NestedContext.Provider value>
        <div className="space-y-6">{children}</div>
      </NestedContext.Provider>
    </section>
  )
}
