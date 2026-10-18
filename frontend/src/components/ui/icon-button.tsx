import type { ReactNode } from 'react'

import { Button, type ButtonProps } from './button'

type IconButtonProps = Omit<ButtonProps, 'size' | 'children' | 'aria-label'> & {
  /** The accessible name, also shown as tooltip. Required: the button has no text. */
  label: string
  icon: ReactNode
}

/** A square button with only an icon, e.g. move up/down or remove in a list. */
export function IconButton({ label, icon, variant = 'ghost', ...props }: IconButtonProps) {
  return (
    <Button size="icon" variant={variant} aria-label={label} title={label} {...props}>
      {icon}
    </Button>
  )
}
