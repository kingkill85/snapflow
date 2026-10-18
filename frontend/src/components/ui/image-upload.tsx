import * as LabelPrimitive from '@radix-ui/react-label'
import { ImagePlus, Trash2, Upload } from 'lucide-react'
import { type DragEvent, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'

import { Button } from './button'

type ImageUploadProps = {
  label: string
  /** URL of the current image; undefined for none. */
  src?: string
  /** A file was chosen or dropped; the caller uploads it. */
  onSelect: (file: File) => void
  onRemove: () => void
  /** While an upload runs: its progress from 0 to 1 (undefined if unknown). */
  pending?: boolean
  progress?: number
  error?: string
  hint?: string
  disabled?: boolean
  /** File types offered by the picker, e.g. "image/png,image/jpeg". */
  accept?: string
}

/**
 * One image: a drop zone with a file picker, a preview with Replace and
 * Remove, and the upload's progress. Uploading is up to the caller.
 */
export function ImageUpload({ label, src, onSelect, onRemove, pending, progress, error, hint, disabled, accept }: ImageUploadProps) {
  const { t } = useTranslation()
  const inputId = useId()
  const messageId = `${inputId}-message`
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const message = error || hint
  const enabled = !disabled && !pending

  const choose = () => input.current?.click()
  const drop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (enabled && file) onSelect(file)
  }
  const percent = progress === undefined ? undefined : Math.round(progress * 100)

  return (
    <div className="group/field space-y-1.5">
      <LabelPrimitive.Root htmlFor={inputId} className="text-sm font-medium">
        {label}
      </LabelPrimitive.Root>
      <input
        ref={input}
        id={inputId}
        type="file"
        accept={accept}
        tabIndex={-1}
        className="sr-only"
        disabled={!enabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={message ? messageId : undefined}
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = '' // choosing the same file again fires again
          if (file) onSelect(file)
        }}
      />
      <div
        data-testid="image-drop-zone"
        onDragOver={(e) => {
          e.preventDefault()
          if (enabled) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
        className={cn(
          'flex flex-wrap items-center gap-4 rounded-control border border-dashed p-4',
          dragging ? 'border-primary bg-primary/5' : error ? 'border-danger' : 'border-line',
        )}
      >
        {src ? (
          <img src={src} alt={label} className="size-32 shrink-0 rounded-control border border-line bg-canvas object-contain" />
        ) : (
          <span aria-hidden="true" className="flex size-32 shrink-0 items-center justify-center rounded-control bg-canvas text-muted [&_svg]:size-8">
            <ImagePlus />
          </span>
        )}
        <div className="min-w-0 flex-1 space-y-2">
          {pending ? (
            <div className="space-y-1">
              <p className="text-sm text-muted">{percent === undefined ? t('upload.uploading') : t('upload.progress', { percent })}</p>
              <div
                role="progressbar"
                aria-label={t('upload.uploading')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="h-1.5 w-full max-w-64 overflow-hidden rounded-full bg-line"
              >
                <div className="h-full bg-primary transition-all" style={{ width: `${percent ?? 100}%` }} />
              </div>
            </div>
          ) : (
            !disabled && (
              <>
                {!src && <p className="text-sm text-muted">{t('upload.drop')}</p>}
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={choose}>
                    <Upload /> {src ? t('upload.replace') : t('upload.choose')}
                  </Button>
                  {src && (
                    <Button size="sm" variant="secondary" onClick={onRemove}>
                      <Trash2 /> {t('upload.remove')}
                    </Button>
                  )}
                </div>
              </>
            )
          )}
          {disabled && !src && <p className="text-sm text-muted">{t('upload.none')}</p>}
        </div>
      </div>
      {message && (
        <p id={messageId} role={error ? 'alert' : undefined} className={cn('text-xs', error ? 'text-danger' : 'text-muted group-has-[:disabled]/field:hidden')}>
          {message}
        </p>
      )}
    </div>
  )
}
