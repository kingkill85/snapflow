import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'

export type Column<T> = {
  header: string
  cell: (row: T) => ReactNode
  className?: string
  /**
   * The column's place in the stacked card of a phone (below 768 px, D117):
   * `title` heads the card (default: the first column that is not `media`),
   * `media` (an image) sits left of the title, every other column is a label
   * and value line below them.
   */
  mobile?: 'title' | 'media'
}

type DataTableProps<T> = {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  /** Action buttons per row, shown right-aligned in the last column (at the bottom of a phone's card). */
  actions?: (row: T) => ReactNode
  empty: ReactNode
}

/**
 * A table; on phones (below `md`) each row is a card: the title column on
 * top, the other columns as label and value lines, the actions at the
 * bottom. It stays one table in the DOM, and every element carries its role
 * explicitly (table, rowgroup, row, columnheader, cell), because browsers drop
 * table semantics from elements whose display changes (D117).
 */
export function DataTable<T>({ rows, columns, rowKey, actions, empty }: DataTableProps<T>) {
  if (rows.length === 0) return <>{empty}</>
  const hasMedia = columns.some((c) => c.mobile === 'media')
  const titleIndex = Math.max(
    0,
    columns.findIndex((c) => c.mobile === 'title') >= 0 ? columns.findIndex((c) => c.mobile === 'title') : columns.findIndex((c) => c.mobile !== 'media'),
  )
  const cellClass = (c: Column<T>, i: number) => {
    if (c.mobile === 'media') return 'max-md:col-start-1 max-md:row-start-1 max-md:block max-md:w-auto max-md:self-center'
    if (i === titleIndex) {
      return cn(
        'max-md:row-start-1 max-md:block max-md:self-center max-md:text-left max-md:text-base max-md:font-medium',
        hasMedia ? 'max-md:col-start-2' : 'max-md:col-span-2',
      )
    }
    return 'max-md:col-span-2 max-md:grid max-md:grid-cols-[minmax(6rem,2fr)_minmax(0,3fr)] max-md:items-baseline max-md:gap-3 max-md:text-left'
  }
  return (
    <div className="relative overflow-x-auto rounded-control border border-line bg-surface max-md:overflow-visible max-md:border-0 max-md:bg-transparent">
      <table role="table" className="w-full text-sm max-md:block">
        <thead role="rowgroup" className="border-b border-line text-left text-muted max-md:sr-only">
          <tr role="row">
            {columns.map((c) => (
              <th key={c.header} role="columnheader" scope="col" className={cn('px-3 py-2.5 font-medium first:pl-4 last:pr-4', c.className)}>
                {c.header}
              </th>
            ))}
            {actions && <th role="columnheader" scope="col" className="w-px" />}
          </tr>
        </thead>
        <tbody role="rowgroup" className="max-md:block max-md:space-y-3">
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              role="row"
              className="border-b border-line last:border-0 max-md:grid max-md:grid-cols-[auto_minmax(0,1fr)] max-md:gap-x-3 max-md:gap-y-2 max-md:rounded-control max-md:border max-md:bg-surface max-md:p-4 max-md:last:border"
            >
              {columns.map((c, i) => {
                const line = c.mobile !== 'media' && i !== titleIndex
                return (
                  <td
                    key={c.header}
                    role="cell"
                    // On a phone a line's label is the header, as CSS content with empty alternative text
                    // (index.css): not part of the cell's text, not read twice by screen readers.
                    data-label={line ? c.header : undefined}
                    className={cn(
                      'px-3 py-2.5 first:pl-4 last:pr-4 max-md:p-0 max-md:first:pl-0 max-md:last:pr-0',
                      c.className,
                      cellClass(c, i),
                    )}
                  >
                    {line ? <div className="min-w-0 break-words md:contents">{c.cell(row)}</div> : c.cell(row)}
                  </td>
                )
              })}
              {actions && (
                <td role="cell" className="py-2 pr-4 pl-3 max-md:col-span-2 max-md:border-t max-md:border-line max-md:p-0 max-md:pt-3">
                  <div className="flex justify-end gap-2 max-md:flex-wrap max-md:justify-start">{actions(row)}</div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
