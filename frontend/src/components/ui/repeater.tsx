import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  ListPlus,
  Trash2,
} from 'lucide-react'
import { type ReactNode, useId } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'

import { IconButton } from './icon-button'

type RepeaterItemProps = {
  /** Names the item, e.g. "Attribute 2"; also its accessible group name. */
  title: string
  /** Names the item inside labels, e.g. "attribute 2" in "Expand attribute 2"; defaults to the title. */
  name?: string
  /** Shown muted next to the title, e.g. the item's key or a summary. */
  subtitle?: ReactNode
  /** Controls in the item's header, usually RepeaterControls. */
  controls?: ReactNode
  /** A smaller, flatter item, e.g. an option inside an attribute. */
  compact?: boolean
  /** Makes the item collapsible: whether its fields are shown (collapsed items do not render them). */
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  /** A field inside has an error: shown in the header, also when collapsed. */
  invalid?: boolean
  /** Identifies the item for useRepeaterFocus, e.g. the useFieldArray id. */
  itemId?: string
  children: ReactNode
}

/** One item of an editable list (a repeated group of fields), with a header and controls. */
export function RepeaterItem({ title, name = title, subtitle, controls, compact, expanded, onExpandedChange, invalid, itemId, children }: RepeaterItemProps) {
  const { t } = useTranslation()
  const titleId = useId()
  const bodyId = useId()
  const collapsible = expanded !== undefined
  const open = !collapsible || expanded
  return (
    <div
      data-repeater-item={itemId}
      role="group"
      aria-labelledby={titleId}
      className={cn(
        'rounded-control border',
        invalid ? 'border-danger' : 'border-line',
        compact ? 'space-y-2 bg-surface p-3' : 'space-y-4 bg-canvas p-4',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          {collapsible && (
            <IconButton
              label={t(expanded ? 'action.collapseItem' : 'action.expandItem', { item: name })}
              icon={expanded ? <ChevronDown /> : <ChevronRight />}
              aria-expanded={expanded}
              aria-controls={expanded ? bodyId : undefined}
              onClick={() => onExpandedChange?.(!expanded)}
            />
          )}
          {invalid && (
            <>
              <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-danger" />
              <span className="sr-only">{t('state.hasErrors')}</span>
            </>
          )}
          <p className={cn('min-w-0 truncate', compact ? 'text-xs font-medium text-muted' : 'text-sm font-semibold')}>
            <span id={titleId} className={cn(invalid && 'text-danger')}>
              {title}
            </span>
            {subtitle && <span className="ml-2 font-normal text-muted">{subtitle}</span>}
          </p>
        </div>
        {controls && <div className="flex shrink-0 flex-wrap justify-end gap-1">{controls}</div>}
      </div>
      {open && (
        <div id={bodyId} className={compact ? 'space-y-2' : 'space-y-4'}>
          {children}
        </div>
      )}
    </div>
  )
}

/** Which control moved an item; focus returns to it (see useRepeaterFocus). */
export type MoveAction = 'up' | 'down' | 'top' | 'bottom'

type RepeaterControlsProps = {
  index: number
  count: number
  /** Names the item in the buttons' labels, e.g. "attribute 3" gives "Remove attribute 3". */
  name: string
  onMove: (from: number, to: number, action: MoveAction) => void
  onRemove: (index: number) => void
  /** Adds an empty item right below. */
  onInsertBelow?: (index: number) => void
  /** Adds a copy right below. */
  onDuplicate?: (index: number) => void
  /** Also offer "move to top" and "move to bottom" (long lists). */
  boundaryMoves?: boolean
}

/** Move / insert / duplicate / remove buttons for a RepeaterItem (moves past the ends are disabled). */
export function RepeaterControls({ index, count, name, onMove, onRemove, onInsertBelow, onDuplicate, boundaryMoves }: RepeaterControlsProps) {
  const { t } = useTranslation()
  const first = index === 0
  const last = index === count - 1
  return (
    <>
      <IconButton
        data-move="up"
        label={t('action.moveUpItem', { item: name })}
        icon={<ArrowUp />}
        disabled={first}
        onClick={() => onMove(index, index - 1, 'up')}
      />
      <IconButton
        data-move="down"
        label={t('action.moveDownItem', { item: name })}
        icon={<ArrowDown />}
        disabled={last}
        onClick={() => onMove(index, index + 1, 'down')}
      />
      {boundaryMoves && (
        <>
          <IconButton
            data-move="top"
            label={t('action.moveTopItem', { item: name })}
            icon={<ArrowUpToLine />}
            disabled={first}
            onClick={() => onMove(index, 0, 'top')}
          />
          <IconButton
            data-move="bottom"
            label={t('action.moveBottomItem', { item: name })}
            icon={<ArrowDownToLine />}
            disabled={last}
            onClick={() => onMove(index, count - 1, 'bottom')}
          />
        </>
      )}
      {onInsertBelow && <IconButton label={t('action.insertBelowItem', { item: name })} icon={<ListPlus />} onClick={() => onInsertBelow(index)} />}
      {onDuplicate && <IconButton label={t('action.duplicateItem', { item: name })} icon={<Copy />} onClick={() => onDuplicate(index)} />}
      <IconButton label={t('action.removeItem', { item: name })} icon={<Trash2 />} className="text-danger" onClick={() => onRemove(index)} />
    </>
  )
}
