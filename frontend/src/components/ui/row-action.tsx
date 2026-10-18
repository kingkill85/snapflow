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
}

/**
 * An action in a table row (Edit, Delete; rule 9, D95): icon + text on wide
 * screens and in the stacked cards of phones, icon only from `md` to `xl` so
 * the columns keep their room. The text stays in the accessible name either
 * way, the tooltip shows it on hover. Delete is `variant="danger-quiet"`.
 */
export function RowAction({ icon, label, to, state, variant = 'secondary', className, ...props }: RowActionProps) {
  const content = (
    <>
      {icon}
      <span className="max-md:not-sr-only md:sr-only xl:not-sr-only">{label}</span>
    </>
  )
  // relative: the hidden text stays inside the button, not at the page edge of a scrolling table.
  const classes = cn('relative px-3 md:w-8 md:px-0 xl:w-auto xl:px-3', className)
  if (to !== undefined) {
    return (
      <Button asChild size="sm" variant={variant} title={label} className={classes}>
        <Link to={to} state={state}>
          {content}
        </Link>
      </Button>
    )
  }
  return (
    <Button size="sm" variant={variant} title={label} className={classes} {...props}>
      {content}
    </Button>
  )
}
