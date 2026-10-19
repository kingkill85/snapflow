import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  CheckboxField,
  type Column,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorMessage,
  IconButton,
  Loading,
  Page,
  RowAction,
} from '@/components/ui'

type Item = { id: string; can: { update: boolean; delete: boolean } }

type Props<T extends Item> = {
  title: string
  description: string
  empty: string
  newLabel: string
  deleteTitle: string
  deleteMessage: (item: T) => string
  moveLabel: (item: T, direction: 'up' | 'down') => string
  /** Shows the "Show inactive" switch (lists with an active flag). */
  inactive?: { show: boolean; onChange: (show: boolean) => void }
  rows: T[]
  pending: boolean
  error: unknown
  columns: Column<T>[]
  canWrite: boolean
  onEdit: (item: T | null) => void
  onDelete: (item: T) => Promise<unknown>
  deletePending: boolean
  deleteError: unknown
  resetDelete: () => void
  reorder: {
    move: (id: string, neighbour: string, direction: 'up' | 'down') => Promise<void>
    moving: boolean
    moveError: unknown
  }
  /** The editor dialog. */
  children: ReactNode
}

/**
 * The shell of an ordered catalog list (load types, output kinds, fields):
 * table with up/down moves, Edit and Delete per row, a create button, the
 * delete confirmation. Read-only without catalog.write.
 */
export function CatalogListPage<T extends Item>(props: Props<T>) {
  const { t: tCommon } = useTranslation()
  const { t } = useTranslation('capabilities')
  const { rows, reorder, canWrite } = props
  const [deleting, setDeleting] = useState<T | null>(null)

  const openDelete = (item: T | null) => {
    props.resetDelete()
    setDeleting(item)
  }
  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await props.onDelete(deleting)
    } catch {
      return // shown by ErrorMessage
    }
    setDeleting(null)
  }

  const columns: Column<T>[] = [
    {
      header: t('position'),
      cell: (p) => rows.indexOf(p) + 1,
      className: 'w-px whitespace-nowrap text-right tabular-nums',
    },
    ...props.columns,
  ]

  const rowActions = (p: T) => {
    const index = rows.indexOf(p)
    return (
      <>
        <IconButton
          label={props.moveLabel(p, 'up')}
          icon={<ArrowUp />}
          disabled={index === 0 || reorder.moving}
          onClick={() => void reorder.move(p.id, rows[index - 1].id, 'up')}
        />
        <IconButton
          label={props.moveLabel(p, 'down')}
          icon={<ArrowDown />}
          disabled={index === rows.length - 1 || reorder.moving}
          onClick={() => void reorder.move(p.id, rows[index + 1].id, 'down')}
        />
        {p.can.update && <RowAction onClick={() => props.onEdit(p)} icon={<Pencil />} label={tCommon('action.edit')} />}
        {p.can.delete && (
          <RowAction variant="danger-quiet" onClick={() => openDelete(p)} icon={<Trash2 />} label={tCommon('action.delete')} />
        )}
      </>
    )
  }

  const createButton = canWrite ? (
    <Button onClick={() => props.onEdit(null)}>
      <Plus /> {props.newLabel}
    </Button>
  ) : undefined

  return (
    <Page width="wide" title={props.title} description={props.description} actions={createButton}>
      {props.inactive && (
        <CheckboxField
          label={t('showInactive')}
          checked={props.inactive.show}
          onChange={(e) => props.inactive?.onChange(e.target.checked)}
        />
      )}
      <ErrorMessage error={reorder.moveError} />
      {props.pending ? (
        <Loading />
      ) : props.error ? (
        <ErrorMessage error={props.error} />
      ) : (
        <DataTable
          rows={rows}
          rowKey={(p) => p.id}
          columns={columns}
          actions={canWrite ? rowActions : undefined}
          empty={<EmptyState title={props.empty} action={createButton} />}
        />
      )}

      {props.children}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && openDelete(null)}
        title={props.deleteTitle}
        message={deleting ? props.deleteMessage(deleting) : ''}
        confirmLabel={tCommon('action.delete')}
        pending={props.deletePending}
        onConfirm={() => void confirmDelete()}
        error={<ErrorMessage error={props.deleteError} />}
      />
    </Page>
  )
}
