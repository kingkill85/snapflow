import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

import { IconButton } from './icon-button'

type SheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  closeLabel: string
  children: ReactNode
}

/** A panel sliding in from the side, e.g. the navigation on phones. Focus stays inside; Escape closes. */
export function Sheet({ open, onOpenChange, title, closeLabel, children }: SheetProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-40 flex w-[min(20rem,calc(100vw-3rem))] flex-col border-l border-edge bg-raised shadow-2xl"
        >
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
            <DialogPrimitive.Title className="font-semibold">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <IconButton label={closeLabel} icon={<X />} />
            </DialogPrimitive.Close>
          </div>
          <div className="flex-1 space-y-6 overflow-y-auto p-4">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/** A titled group of entries inside a Sheet. */
export function SheetGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-1">
      <h2 className="px-3 text-xs font-medium tracking-wide text-muted uppercase">{title}</h2>
      {children}
    </section>
  )
}
