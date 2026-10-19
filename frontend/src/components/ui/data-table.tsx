import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/cn'

export type Column<T> = {
  header: string
  /** React key of the column, when headers may repeat (e.g. one column per plan); default the header. */
  key?: string
  cell: (row: T) => ReactNode
  className?: string
  /**
   * The column's place in the stacked card of a phone (below 768 px, D117):
   * `title` heads the card (default: the first column that is not `media`),
   * `media` (an image) sits left of the title, every other column is a label
   * and value line below them; `block` puts the label above the value at the
   * card's full width (e.g. a dropdown to choose in each row).
   */
  mobile?: 'title' | 'media' | 'block'
}

type DataTableProps<T> = {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  /** Action buttons per row, shown right-aligned in the last column (at the bottom of a phone's card). */
  actions?: (row: T) => ReactNode
  empty: ReactNode
  /** The table's accessible name, when no heading right above it names it. */
  label?: string
  /**
   * Without a box of its own, for a table inside a card (e.g. the fields of a
   * diff): rows are separated by lines, also on phones instead of cards.
   */
  flat?: boolean
  /**
   * Column headers for screen readers only, for label and value pairs whose
   * labels say it all (e.g. the fields of something new in a diff).
   */
  hideHeader?: boolean
  /**
   * Rows under group header rows (e.g. a bill of materials by product type
   * and category): each group's `header` spans the whole row, its rows
   * follow. When given, it replaces `rows` for rendering (`rows` still
   * decides whether the table is empty).
   */
  groups?: TableGroup<T>[]
}

export type TableGroup<T> = { key: string; header: ReactNode; rows: T[]; level?: 1 | 2 }

/**
 * A table; on phones (below `md`) each row is a card: the title column on
 * top, the other columns as label and value lines, the actions at the
 * bottom. It stays one table in the DOM, and every element carries its role
 * explicitly (table, rowgroup, row, columnheader, cell), because browsers drop
 * table semantics from elements whose display changes (D117).
 */
export function DataTable<T>({ rows, columns, rowKey, actions, empty, label, flat, hideHeader, groups }: DataTableProps<T>) {
  const scroller = useRef<HTMLDivElement>(null)
  const cue = useScrollCue(scroller, rows.length > 0)
  if (rows.length === 0) return <>{empty}</>
  const hasMedia = columns.some((c) => c.mobile === 'media')
  const titleIndex = Math.max(
    0,
    columns.findIndex((c) => c.mobile === 'title') >= 0 ? columns.findIndex((c) => c.mobile === 'title') : columns.findIndex((c) => c.mobile !== 'media'),
  )
  const cellClass = (c: Column<T>, i: number) => {
    // Beside a flat table's long values (a field's label) at their top, beside a card's title centred.
    if (c.mobile === 'media') return cn('max-md:col-start-1 max-md:row-start-1 max-md:block max-md:w-auto', flat ? 'max-md:self-start' : 'max-md:self-center')
    if (c.mobile === 'block') return 'max-md:col-span-2 max-md:block max-md:text-left'
    if (i === titleIndex) {
      return cn(
        'max-md:row-start-1 max-md:block max-md:self-center max-md:text-left max-md:font-medium',
        flat ? 'max-md:text-sm' : 'max-md:text-base',
        hasMedia ? 'max-md:col-start-2' : 'max-md:col-span-2',
      )
    }
    return 'max-md:col-span-2 max-md:grid max-md:grid-cols-[minmax(6rem,2fr)_minmax(0,3fr)] max-md:items-baseline max-md:gap-3 max-md:text-left'
  }
  return (
    <div className={cn('relative', !flat && 'rounded-control border border-line bg-surface max-md:border-0 max-md:bg-transparent')}>
      <div ref={scroller} className="overflow-x-auto max-md:overflow-visible">
        <table role="table" aria-label={label} className="w-full text-sm max-md:block">
          <thead role="rowgroup" className={cn('border-b border-line text-left text-muted max-md:sr-only', flat && 'text-xs', hideHeader && 'sr-only')}>
            <tr role="row">
              {columns.map((c) => (
                <th key={c.key ?? c.header} role="columnheader" scope="col" className={cn('px-3 font-medium', flat ? 'py-1.5 first:pl-0 last:pr-0' : 'py-2.5 first:pl-4 last:pr-4', c.className)}>
                  {c.header}
                </th>
              ))}
              {actions && <th role="columnheader" scope="col" className="w-px" />}
            </tr>
          </thead>
          <tbody role="rowgroup" className={cn('max-md:block', flat ? 'max-md:space-y-2' : 'max-md:space-y-3')}>
            {(groups ?? [{ key: '', header: null, rows }]).map((group) => [
              group.header != null && (
                <tr key={`group-${group.key}`} role="row" className={cn('border-b border-line max-md:block max-md:border-0', group.level === 2 ? 'bg-canvas/50' : 'bg-canvas')}>
                  <th
                    role="rowheader"
                    scope="row"
                    colSpan={columns.length + (actions ? 1 : 0)}
                    className={cn('px-3 py-2 text-left first:pl-4 last:pr-4 max-md:block max-md:px-0', group.level === 2 ? 'text-sm font-normal' : 'font-semibold')}
                  >
                    {group.header}
                  </th>
                </tr>
              ),
              ...group.rows.map((row) => {
              const rowActions = actions?.(row)
              return (
                <tr
                  key={rowKey(row)}
                  role="row"
                  className={cn(
                    'border-b border-line last:border-0 max-md:grid max-md:grid-cols-[auto_minmax(0,1fr)] max-md:gap-x-3',
                    flat
                      ? 'max-md:gap-y-1 max-md:pb-2 max-md:last:pb-0'
                      : 'max-md:gap-y-2 max-md:rounded-control max-md:border max-md:bg-surface max-md:p-4 max-md:last:border',
                  )}
                >
                  {columns.map((c, i) => {
                    const line = c.mobile !== 'media' && i !== titleIndex
                    const block = c.mobile === 'block'
                    const content = c.cell(row)
                    // A phone's card leaves out a label line without a value (e.g. an empty note).
                    const blank = content == null || content === false || content === ''
                    return (
                      <td
                        key={c.key ?? c.header}
                        role="cell"
                        // On a phone a line's label is the header, as CSS content with empty alternative text
                        // (index.css): not part of the cell's text, not read twice by screen readers.
                        data-label={line ? c.header : undefined}
                        data-mobile={block ? 'block' : undefined}
                        className={cn(
                          'px-3 max-md:p-0 max-md:first:pl-0 max-md:last:pr-0',
                          flat ? 'py-1.5 align-top first:pl-0 last:pr-0' : 'py-2.5 first:pl-4 last:pr-4',
                          c.className,
                          cellClass(c, i),
                          line && blank && 'max-md:hidden',
                        )}
                      >
                        {line ? <div className="min-w-0 break-words md:contents">{content}</div> : content}
                      </td>
                    )
                  })}
                  {actions && (
                    // A row without actions (e.g. nothing it may do) has no empty bar at the bottom of its card.
                    <td
                      role="cell"
                      className={cn('py-2 pr-4 pl-3 max-md:col-span-2 max-md:border-t max-md:border-line max-md:p-0 max-md:pt-3', (rowActions == null || rowActions === false) && 'max-md:hidden')}
                    >
                      <div className="flex justify-end gap-2 max-md:flex-wrap max-md:justify-start">{rowActions}</div>
                    </td>
                  )}
                </tr>
              )
            }),
            ])}
          </tbody>
        </table>
      </div>
      {/* A table wider than its box fades out at the edge it scrolls to (not on phones: cards there). */}
      {cue.left && <div aria-hidden="true" data-scroll-cue="left" className={cn(fade, 'left-0 rounded-l-control bg-linear-to-r')} />}
      {cue.right && <div aria-hidden="true" data-scroll-cue="right" className={cn(fade, 'right-0 rounded-r-control bg-linear-to-l')} />}
    </div>
  )
}

const fade = 'pointer-events-none absolute inset-y-0 w-10 from-surface to-transparent max-md:hidden'

/** Whether the box can scroll further left or right, kept up to date while it scrolls or resizes. */
function useScrollCue(ref: RefObject<HTMLDivElement | null>, active: boolean) {
  const [cue, setCue] = useState({ left: false, right: false })
  useEffect(() => {
    const box = ref.current
    if (!active || !box) return
    const update = () => {
      const max = box.scrollWidth - box.clientWidth
      const next = { left: box.scrollLeft > 1, right: box.scrollLeft < max - 1 }
      setCue((c) => (c.left === next.left && c.right === next.right ? c : next))
    }
    update()
    box.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    observer?.observe(box)
    if (box.firstElementChild) observer?.observe(box.firstElementChild)
    return () => {
      box.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [ref, active])
  return cue
}
