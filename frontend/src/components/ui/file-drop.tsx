import * as LabelPrimitive from '@radix-ui/react-label'
import { FileSpreadsheet, Upload } from 'lucide-react'
import { type DragEvent, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'

import { Button } from './button'

type FileDropProps = {
  label: string
  /** The chosen file, shown with its name and size. */
  file?: File
  onSelect: (file: File) => void
  /** File types offered by the picker, e.g. ".xlsx,.csv". */
  accept?: string
  /** What may be dropped, e.g. "Excel workbooks (.xlsx) or CSV files up to 50 MB". */
  hint?: string
  error?: string
  disabled?: boolean
  /** While an upload runs: its progress from 0 to 1 (undefined if unknown). */
  pending?: boolean
  progress?: number
}

/** "1.5 MB" in the UI language. */
function useFormatSize() {
  const { i18n } = useTranslation()
  return (bytes: number) => {
    const mb = bytes / (1024 * 1024)
    const format = new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en', { maximumFractionDigits: mb < 10 ? 1 : 0 })
    return mb >= 0.1 ? `${format.format(mb)} MB` : `${format.format(Math.max(1, Math.round(bytes / 1024)))} KB`
  }
}

/**
 * A file of any kind (e.g. an import workbook): a drop zone with a file
 * picker, the chosen file's name and size, and an upload's progress.
 * Uploading is up to the caller.
 */
export function FileDrop({ label, file, onSelect, accept, hint, error, disabled, pending, progress }: FileDropProps) {
  const { t } = useTranslation()
  const size = useFormatSize()
  const inputId = useId()
  const messageId = `${inputId}-message`
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const enabled = !disabled && !pending
  const percent = progress === undefined ? undefined : Math.round(progress * 100)
  const message = error || hint

  const drop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const dropped = e.dataTransfer.files[0]
    if (enabled && dropped) onSelect(dropped)
  }

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
        aria-describedby={message ? messageId : undefined}
        onChange={(e) => {
          const chosen = e.target.files?.[0]
          e.target.value = ''
          if (chosen) onSelect(chosen)
        }}
      />
      <div
        data-testid="file-drop-zone"
        onDragOver={(e) => {
          e.preventDefault()
          if (enabled) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
        className={cn(
          'flex flex-col items-center gap-3 rounded-control border border-dashed px-4 py-8 text-center sm:py-10',
          dragging ? 'border-primary bg-primary/5' : error ? 'border-danger' : file ? 'border-primary/50 bg-primary/5' : 'border-line',
        )}
      >
        <span aria-hidden="true" className="flex size-12 items-center justify-center rounded-full bg-canvas text-muted [&_svg]:size-6">
          <FileSpreadsheet />
        </span>
        {file ? (
          <p className="max-w-full text-sm break-all">
            <span className="font-medium">{file.name}</span> <span className="text-muted tabular-nums">({size(file.size)})</span>
          </p>
        ) : (
          <p className="text-sm text-muted">{t('upload.dropFile')}</p>
        )}
        {pending ? (
          <div className="w-full max-w-64 space-y-1">
            <p className="text-sm text-muted">{percent === undefined ? t('upload.uploading') : t('upload.progress', { percent })}</p>
            <div
              role="progressbar"
              aria-label={t('upload.uploading')}
              aria-valuemin={percent === undefined ? undefined : 0}
              aria-valuemax={percent === undefined ? undefined : 100}
              aria-valuenow={percent}
              className="h-1.5 w-full overflow-hidden rounded-full bg-line"
            >
              {percent === undefined ? (
                <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
              ) : (
                <div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} />
              )}
            </div>
          </div>
        ) : (
          !disabled && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => input.current?.click()}
              aria-invalid={error ? true : undefined}
              aria-describedby={message ? messageId : undefined}
            >
              <Upload /> {file ? t('upload.replace') : t('upload.choose')}
            </Button>
          )
        )}
      </div>
      {message && (
        <p id={messageId} role={error ? 'alert' : undefined} className={cn('text-xs', error ? 'text-danger' : 'text-muted')}>
          {message}
        </p>
      )}
    </div>
  )
}
