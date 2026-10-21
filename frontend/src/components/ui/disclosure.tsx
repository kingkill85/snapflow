import { ChevronRight } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'

import { cn } from '@/lib/cn'

type DisclosureProps = {
  title: string
  /** A line under the title, shown while collapsed too (e.g. what is inside). */
  description?: string
  /** Controlled: open state and its setter. Without them it starts as `defaultOpen`. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
  children: ReactNode
}

/**
 * A collapsible group of form fields, e.g. "Advanced" settings with good
 * defaults: a toggle with a chevron, the content below it. Collapsed, the
 * content stays mounted (hidden), so form fields keep their values and
 * registration; open it when one of them has an error.
 */
export function Disclosure({ title, description, open, onOpenChange, defaultOpen = false, children }: DisclosureProps) {
  const contentId = useId()
  const [own, setOwn] = useState(defaultOpen)
  const isOpen = open ?? own
  const toggle = () => {
    if (open === undefined) setOwn(!isOpen)
    onOpenChange?.(!isOpen)
  }
  return (
    <div className="space-y-3">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={contentId}
        onClick={toggle}
        className="group flex w-full items-start gap-2 rounded-control text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <ChevronRight aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0 text-muted transition-transform', isOpen && 'rotate-90')} />
        <span className="min-w-0 space-y-0.5">
          <span className="block text-sm font-medium group-hover:text-primary">{title}</span>
          {description && <span className="block text-sm text-muted">{description}</span>}
        </span>
      </button>
      <div id={contentId} role="group" aria-label={title} hidden={!isOpen} className="space-y-4 pl-6">
        {children}
      </div>
    </div>
  )
}
