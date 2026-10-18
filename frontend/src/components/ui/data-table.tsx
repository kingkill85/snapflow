import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'

export type Column<T> = {
  header: string
  cell: (row: T) => ReactNode
  className?: string
}

type DataTableProps<T> = {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  /** Action buttons per row, shown right-aligned in the last column. */
  actions?: (row: T) => ReactNode
  empty: ReactNode
}

export function DataTable<T>({ rows, columns, rowKey, actions, empty }: DataTableProps<T>) {
  if (rows.length === 0) return <>{empty}</>
  return (
    <div className="relative overflow-x-auto rounded-control border border-line bg-surface">
      <table className="w-full text-sm">
        <thead className="border-b border-line text-left text-muted">
          <tr>
            {columns.map((c) => (
              <th key={c.header} scope="col" className={cn('px-3 py-2.5 font-medium first:pl-4 last:pr-4', c.className)}>
                {c.header}
              </th>
            ))}
            {actions && <th scope="col" className="w-px" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-b border-line last:border-0">
              {columns.map((c) => (
                <td key={c.header} className={cn('px-3 py-2.5 first:pl-4 last:pr-4', c.className)}>
                  {c.cell(row)}
                </td>
              ))}
              {actions && (
                <td className="py-2 pr-4 pl-3">
                  <div className="flex justify-end gap-2">{actions(row)}</div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
