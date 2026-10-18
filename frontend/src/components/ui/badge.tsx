import { cva, type VariantProps } from 'class-variance-authority'
import type { ReactNode } from 'react'

const badgeVariants = cva('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3.5', {
  variants: {
    variant: {
      neutral: 'border-line bg-canvas text-muted',
      primary: 'border-primary/30 bg-primary/10 text-primary',
      success: 'border-success/30 bg-success/10 text-success',
      warning: 'border-warning/40 bg-warning/10 text-warning',
      danger: 'border-danger/30 bg-danger/10 text-danger',
    },
  },
  defaultVariants: { variant: 'neutral' },
})

type BadgeProps = VariantProps<typeof badgeVariants> & {
  children: ReactNode
  /** Explains the badge on hover; also read by screen readers when `children` is only a number or icon. */
  title?: string
}

export function Badge({ variant, title, children }: BadgeProps) {
  return (
    <span className={badgeVariants({ variant })} title={title}>
      {children}
      {title && <span className="sr-only">{title}</span>}
    </span>
  )
}
