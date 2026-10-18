import { type ReactNode, useId } from 'react'

type SectionProps = {
  title: string
  description?: string
  children: ReactNode
}

/** A titled card that groups related content on a page, e.g. one form. */
export function Section({ title, description, children }: SectionProps) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="space-y-4 rounded-control border border-line bg-surface p-6">
      <div className="space-y-1">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        {description && <p className="text-sm text-muted">{description}</p>}
      </div>
      {children}
    </section>
  )
}
