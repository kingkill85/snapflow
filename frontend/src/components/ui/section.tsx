import type { ReactNode } from 'react'

type SectionProps = {
  title: string
  description?: string
  children: ReactNode
}

/** A titled card that groups related content on a page, e.g. one form. */
export function Section({ title, description, children }: SectionProps) {
  return (
    <section className="space-y-4 rounded-control border border-line bg-surface p-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{title}</h2>
        {description && <p className="text-sm text-muted">{description}</p>}
      </div>
      {children}
    </section>
  )
}
