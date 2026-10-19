import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DataTable } from './data-table'

type Row = { id: string; name: string; deletable: boolean }
const rows: Row[] = [
  { id: '1', name: 'Kept', deletable: false },
  { id: '2', name: 'Removable', deletable: true },
]

describe('DataTable', () => {
  it('leaves out the action bar of a phone card whose row has no actions', () => {
    render(
      <DataTable
        rows={rows}
        rowKey={(r) => r.id}
        columns={[{ header: 'Name', cell: (r) => r.name }]}
        actions={(r) => r.deletable && <span>Delete {r.name}</span>}
        empty={null}
      />,
    )
    const [kept, removable] = screen.getAllByRole('row').slice(1)
    expect(kept.lastElementChild).toHaveClass('max-md:hidden')
    expect(removable.lastElementChild).not.toHaveClass('max-md:hidden')
  })

  it('leaves out a phone card line without a value', () => {
    render(
      <DataTable
        rows={rows}
        rowKey={(r) => r.id}
        columns={[
          { header: 'Name', cell: (r) => r.name },
          { header: 'Note', cell: (r) => (r.deletable ? 'Spare' : null) },
        ]}
        empty={null}
      />,
    )
    const [kept, removable] = screen.getAllByRole('row').slice(1)
    expect(kept.children[1]).toHaveClass('max-md:hidden')
    expect(removable.children[1]).not.toHaveClass('max-md:hidden')
  })

  it('keeps the column headers for screen readers only when asked to hide them', () => {
    const { rerender } = render(<DataTable flat rows={rows} rowKey={(r) => r.id} columns={[{ header: 'Name', cell: (r) => r.name }]} empty={null} />)
    expect(screen.getAllByRole('rowgroup')[0]).not.toHaveClass('sr-only')
    rerender(<DataTable flat hideHeader rows={rows} rowKey={(r) => r.id} columns={[{ header: 'Name', cell: (r) => r.name }]} empty={null} />)
    expect(screen.getAllByRole('rowgroup')[0]).toHaveClass('sr-only')
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument()
  })

  it('marks group headers as row headers spanning the row', () => {
    render(
      <DataTable
        rows={rows}
        rowKey={(r) => r.id}
        columns={[{ header: 'Name', cell: (r) => r.name }, { header: 'Id', cell: (r) => r.id }]}
        groups={[{ key: 'g', header: 'Group A', rows }]}
        empty={null}
      />,
    )
    const header = screen.getByRole('rowheader', { name: 'Group A' })
    expect(header.tagName).toBe('TH')
    expect(header).toHaveAttribute('colspan', '2')
    expect(screen.getAllByRole('cell')).toHaveLength(4)
  })
})
