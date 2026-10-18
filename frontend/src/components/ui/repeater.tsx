import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Ellipsis,
  ListPlus,
  Trash2,
} from 'lucide-react'
import { type ReactNode, useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'

import { IconButton } from './icon-button'
import { Menu, MenuItem, MenuSeparator } from './menu'

type RepeaterItemProps = {
  /** The item's title, e.g. an attribute's label; also its accessible group name unless `groupLabel` is given. */
  title: string
  /** Names the item inside labels, e.g. "attribute 2" in "Expand attribute 2"; defaults to the title. */
  name?: string
  /** The group's accessible name when it should differ from the title, e.g. "Attribute 2: Bus system". */
  groupLabel?: string
  /** Shown muted before the title, e.g. the position. */
  prefix?: ReactNode
  /** Shown muted after the title, e.g. the item's key, type and unit. */
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
export function RepeaterItem({
  title,
  name = title,
  groupLabel,
  prefix,
  subtitle,
  controls,
  compact,
  expanded,
  onExpandedChange,
  invalid,
  itemId,
  children,
}: RepeaterItemProps) {
  const { t } = useTranslation()
  const titleId = useId()
  const bodyId = useId()
  const collapsible = expanded !== undefined
  const open = !collapsible || expanded
  return (
    <div
      data-repeater-item={itemId}
      role="group"
      aria-labelledby={groupLabel ? undefined : titleId}
      aria-label={groupLabel}
      className={cn(
        'rounded-control border',
        invalid ? 'border-danger' : 'border-line',
        compact ? 'space-y-2 bg-surface p-3' : 'space-y-4 bg-canvas p-4',
      )}
    >
      {/* Narrow screens: the controls wrap below the title instead of squeezing it away. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 basis-48 items-center gap-1">
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
            {prefix && <span className="mr-2 font-normal text-muted tabular-nums">{prefix}</span>}
            <span id={titleId} className={cn(invalid && 'text-danger')}>
              {title}
            </span>
            {subtitle && <span className="ml-2 text-xs font-normal text-muted">{subtitle}</span>}
          </p>
        </div>
        {controls && <div className="ml-auto flex flex-wrap justify-end gap-1">{controls}</div>}
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

/**
 * The controls of a RepeaterItem: move up and down stay visible (moves past
 * the ends are disabled); the rarer actions (move to top or bottom, insert
 * below, duplicate, remove) sit in a "⋯" menu when there are any besides
 * remove, otherwise remove is a button of its own (D114).
 */
export function RepeaterControls({ index, count, name, onMove, onRemove, onInsertBelow, onDuplicate, boundaryMoves }: RepeaterControlsProps) {
  const { t } = useTranslation()
  const first = index === 0
  const last = index === count - 1
  // An entry was chosen: the repeater moves focus itself (useRepeaterFocus), the menu must not take it back.
  const acted = useRef(false)
  const act = (action: () => void) => () => {
    acted.current = true
    action()
  }
  const remove = { label: t('action.removeItem', { item: name }), icon: <Trash2 /> }
  const menu = boundaryMoves || onInsertBelow || onDuplicate
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
      {menu ? (
        <Menu
          align="end"
          label={t('action.moreItem', { item: name })}
          trigger={<IconButton label={t('action.moreItem', { item: name })} icon={<Ellipsis />} />}
          onCloseAutoFocus={(e) => {
            if (acted.current) e.preventDefault()
            acted.current = false
          }}
        >
          {boundaryMoves && (
            <>
              <MenuItem disabled={first} onSelect={act(() => onMove(index, 0, 'top'))}>
                <ArrowUpToLine /> {t('action.moveTop')}
              </MenuItem>
              <MenuItem disabled={last} onSelect={act(() => onMove(index, count - 1, 'bottom'))}>
                <ArrowDownToLine /> {t('action.moveBottom')}
              </MenuItem>
            </>
          )}
          {(onInsertBelow || onDuplicate) && (
            <>
              {boundaryMoves && <MenuSeparator />}
              {onInsertBelow && (
                <MenuItem onSelect={act(() => onInsertBelow(index))}>
                  <ListPlus /> {t('action.insertBelow')}
                </MenuItem>
              )}
              {onDuplicate && (
                <MenuItem onSelect={act(() => onDuplicate(index))}>
                  <Copy /> {t('action.duplicate')}
                </MenuItem>
              )}
            </>
          )}
          <MenuSeparator />
          <MenuItem danger onSelect={act(() => onRemove(index))}>
            {remove.icon} {t('action.remove')}
          </MenuItem>
        </Menu>
      ) : (
        <IconButton label={remove.label} icon={remove.icon} className="text-danger" onClick={() => onRemove(index)} />
      )}
    </>
  )
}
