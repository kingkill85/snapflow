import * as DialogPrimitive from '@radix-ui/react-dialog'
import type { FormEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from './button'
import { keepDialogOnComboboxEscape } from './combobox-escape'

type DialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
  footer: ReactNode
}

/** Base dialog: title, scrollable body, fixed footer. */
export function Dialog({ open, onOpenChange, title, description, children, footer }: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <DialogPrimitive.Content onEscapeKeyDown={keepDialogOnComboboxEscape} className="fixed top-1/2 left-1/2 flex max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 z-40 rounded-control border border-edge bg-raised p-6 shadow-2xl">
          <div className="space-y-1">
            <DialogPrimitive.Title className="text-lg font-semibold">{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="text-sm text-muted">{description}</DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
            )}
          </div>
          {children}
          <div className="flex justify-end gap-2">{footer}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

type FormDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  submitLabel: string
  submitting: boolean
  /** Keeps submit disabled, e.g. while data the form needs is still loading. */
  submitDisabled?: boolean
  onSubmit: () => void
  /** Shown above the fields, e.g. a translated API error. */
  error?: ReactNode
  children: ReactNode
  /**
   * Docks the dialog non-modally at the top of this element (positioned) instead of centring it over a scrim,
   * so what it is about stays visible, e.g. the line measured in the plan editor (D225). Clicks outside keep it open; Esc and Cancel close it.
   */
  container?: HTMLElement | null
}

/** The one form-in-a-dialog pattern: scrollable fields, Cancel + submit. */
export function FormDialog({ open, onOpenChange, title, submitLabel, submitting, submitDisabled, onSubmit, error, children, container }: FormDialogProps) {
  const { t } = useTranslation()
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    // React bubbles events through portals: a dialog opened inside another
    // form (e.g. a field created from a category attribute) must not submit it.
    e.stopPropagation()
    if (submitDisabled) return
    onSubmit()
  }
  const docked = !!container
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={!docked}>
      <DialogPrimitive.Portal container={container ?? undefined}>
        {!docked && <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-scrim" />}
        <DialogPrimitive.Content
          onEscapeKeyDown={keepDialogOnComboboxEscape}
          onInteractOutside={docked ? (e) => e.preventDefault() : undefined}
          className={
            docked
              ? 'absolute inset-x-2 top-2 z-40 flex max-h-[calc(100%-1rem)] flex-col rounded-control border border-edge bg-raised p-4 shadow-2xl'
              : 'fixed top-1/2 left-1/2 flex max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col z-40 rounded-control border border-edge bg-raised p-6 shadow-2xl'
          }
        >
          <DialogPrimitive.Title className="mb-4 text-lg font-semibold">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col" noValidate>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-1 pb-1">
              {error}
              {children}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                {t('action.cancel')}
              </Button>
              <Button type="submit" disabled={submitting || submitDisabled}>
                {submitLabel}
              </Button>
            </div>
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

type ConfirmDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  message: string
  confirmLabel: string
  /** The confirm button: `danger` (default) for what cannot be undone, `primary` for a reversible step such as archiving (D184). */
  confirmVariant?: 'danger' | 'primary'
  /** Defaults to "Cancel". */
  cancelLabel?: string
  pending: boolean
  onConfirm: () => void
  error?: ReactNode
}

/** The one delete/confirm pattern. */
export function ConfirmDialog({ open, onOpenChange, title, message, confirmLabel, confirmVariant = 'danger', cancelLabel, pending, onConfirm, error }: ConfirmDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={message}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {cancelLabel ?? t('action.cancel')}
          </Button>
          <Button variant={confirmVariant} disabled={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {error}
    </Dialog>
  )
}
