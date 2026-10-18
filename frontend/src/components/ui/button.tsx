import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'

import { cn } from '@/lib/cn'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-control font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-ink hover:bg-primary/90',
        secondary: 'border border-line bg-surface hover:bg-canvas',
        /** Solid: only for confirming a destructive action (ConfirmDialog). */
        danger: 'bg-danger text-danger-ink hover:bg-danger/90',
        /** A destructive action offered among others (row Delete, Remove): quiet until hovered. */
        'danger-quiet': 'border border-line bg-surface text-danger hover:border-danger/40 hover:bg-danger/10',
        ghost: 'hover:bg-canvas',
      },
      size: {
        sm: 'h-8 px-3 text-sm',
        md: 'h-9 px-4 text-sm',
        icon: 'size-8 shrink-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
)

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }

export function Button({ className, variant, size, asChild, type = 'button', ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button'
  return <Comp type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
