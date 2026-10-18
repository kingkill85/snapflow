import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import { type ReactNode, useId } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'

import { IconButton } from './icon-button'

type RepeaterItemProps = {
  /** Names the item, e.g. "Attribute 2"; also its accessible group name. */
  title: string
  /** Shown muted next to the title, e.g. the item's key. */
  subtitle?: string
  /** Controls in the item's header, usually RepeaterControls. */
  controls?: ReactNode
  /** A smaller, flatter item, e.g. an option inside an attribute. */
  compact?: boolean
  children: ReactNode
}

/** One item of an editable list (a repeated group of fields), with a header and controls. */
export function RepeaterItem({ title, subtitle, controls, compact, children }: RepeaterItemProps) {
  const titleId = useId()
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className={cn('rounded-control border border-line', compact ? 'space-y-2 bg-surface p-3' : 'space-y-4 bg-canvas p-4')}
    >
      <div className="flex items-center justify-between gap-2">
        <p className={cn('min-w-0 truncate', compact ? 'text-xs font-medium text-muted' : 'text-sm font-semibold')}>
          <span id={titleId}>{title}</span>
          {subtitle && <span className="ml-2 font-normal text-muted">{subtitle}</span>}
        </p>
        {controls && <div className="flex shrink-0 gap-1">{controls}</div>}
      </div>
      {children}
    </div>
  )
}

type RepeaterControlsProps = {
  index: number
  count: number
  onMove: (from: number, to: number) => void
  onRemove: (index: number) => void
}

/** Move up / move down / remove buttons for a RepeaterItem (first up and last down disabled). */
export function RepeaterControls({ index, count, onMove, onRemove }: RepeaterControlsProps) {
  const { t } = useTranslation()
  return (
    <>
      <IconButton label={t('action.moveUp')} icon={<ArrowUp />} disabled={index === 0} onClick={() => onMove(index, index - 1)} />
      <IconButton label={t('action.moveDown')} icon={<ArrowDown />} disabled={index === count - 1} onClick={() => onMove(index, index + 1)} />
      <IconButton label={t('action.remove')} icon={<Trash2 />} className="text-danger" onClick={() => onRemove(index)} />
    </>
  )
}
