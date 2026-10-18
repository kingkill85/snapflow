import { cva, type VariantProps } from 'class-variance-authority'
import type { ReactNode } from 'react'

const badgeVariants = cva('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', {
  variants: {
    variant: {
      neutral: 'border-line bg-canvas text-muted',
      primary: 'border-primary/30 bg-primary/10 text-primary',
      success: 'border-success/30 bg-success/10 text-success',
      danger: 'border-danger/30 bg-danger/10 text-danger',
    },
  },
  defaultVariants: { variant: 'neutral' },
})

export function Badge({ variant, children }: VariantProps<typeof badgeVariants> & { children: ReactNode }) {
  return <span className={badgeVariants({ variant })}>{children}</span>
}
