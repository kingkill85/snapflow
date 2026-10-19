import type { ReactNode } from 'react'
import { Link, type To } from 'react-router'

import { cn } from '@/lib/cn'

import { Button, type ButtonProps } from './button'

type RowActionProps = Omit<ButtonProps, 'size' | 'children' | 'asChild'> & {
  icon: ReactNode
  /** The action's name: text from 1280 px up, below that tooltip and accessible name of the icon-only button. */
  label: string
  /** Makes it a link, e.g. Edit to a page editor. */
  to?: To
  state?: unknown
  /** Makes it a download link to this URL (an API file), e.g. Download of a generated document. */
  download?: string
  /** Icon only below 1280 px, phones included, e.g. in narrow cards where the text would wrap the actions (D226). */
  compact?: boolean
}

/**
 * An action in a table row (Edit, Delete; rule 9, D95): icon + text on wide
 * screens and in the stacked cards of phones, icon only from `md` to `xl` so
 * the columns keep their room. The text stays in the accessible name either
 * way, the tooltip shows it on hover. Delete is `variant="danger-quiet"`.
 */
export function RowAction({ icon, label, to, state, download, compact, variant = 'secondary', className, ...props }: RowActionProps) {
  const content = (
    <>
      {icon}
      <span className={compact ? 'sr-only xl:not-sr-only' : 'max-md:not-sr-only md:sr-only xl:not-sr-only'}>{label}</span>
    </>
  )
  // relative: the hidden text stays inside the button, not at the page edge of a scrolling table.
  const classes = cn(compact ? 'relative w-8 px-0 xl:w-auto xl:px-3' : 'relative px-3 md:w-8 md:px-0 xl:w-auto xl:px-3', className)
  if (to !== undefined) {
    return (
      <Button asChild size="sm" variant={variant} title={label} className={classes}>
        <Link to={to} state={state}>
          {content}
        </Link>
      </Button>
    )
  }
  if (download !== undefined) {
    return (
      <Button asChild size="sm" variant={variant} title={label} className={classes}>
        <a href={download} download>
          {content}
        </a>
      </Button>
    )
  }
  return (
    <Button size="sm" variant={variant} title={label} className={classes} {...props}>
      {content}
    </Button>
  )
}
