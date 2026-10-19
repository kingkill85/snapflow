import { ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useDeleteManualLine, useReorderManualLines } from '@/api/generated/bom/bom'
import type { ManualLine } from '@/api/generated/model'
import { Button, ConfirmDialog, DataTable, EmptyState, ErrorMessage, IconButton, RowAction, Section } from '@/components/ui'

import { useFormatMoney, useLineName, useRefreshBom } from './format'
import { ManualLineDialog, type ManualLineKindChoice } from './ManualLineDialog'

type Props = {
  versionId: string
  lines: ManualLine[]
  /** The project currency of the converted amounts. */
  currency: string
  canWrite: boolean
  productTypeIds: string[]
}

/** The version's manual lines in their order: add (catalog product or free text), edit, reorder, delete. */
export function ManualLinesSection({ versionId, lines, currency, canWrite, productTypeIds }: Props) {
  const { t } = useTranslation('bom')
  const { t: tCommon } = useTranslation()
  const money = useFormatMoney()
  const lineName = useLineName()
  const refresh = useRefreshBom(versionId)
  const reorder = useReorderManualLines()
  const remove = useDeleteManualLine()
  // undefined: closed; null: a new line of `newKind`; an id: edit that line (read from the current lines, so a refetch brings its newer updatedAt).
  const [editing, setEditing] = useState<string | null | undefined>(undefined)
  const [newKind, setNewKind] = useState<ManualLineKindChoice>('catalog')
  const [deleting, setDeleting] = useState<ManualLine | null>(null)
  // USD and, for another project currency, the API's converted amount below it (like the BOM lines, D239).
  const amount = (value: string, converted: string | undefined) => (
    <span className="block text-right whitespace-nowrap tabular-nums max-md:text-left">
      {money(value)}
      {converted != null && <span className="block text-xs text-muted">{money(converted, currency)}</span>}
    </span>
  )
  const editItem = typeof editing === 'string' ? (lines.find((l) => l.id === editing) ?? null) : null

  const add = (kind: ManualLineKindChoice) => {
    setNewKind(kind)
    setEditing(null)
  }
  const move = async (index: number, by: -1 | 1) => {
    const ids = lines.map((l) => l.id)
    const [id] = ids.splice(index, 1)
    ids.splice(index + by, 0, id)
    try {
      await reorder.mutateAsync({ versionId, data: { ids } })
    } catch {
      // shown by ErrorMessage via reorder.error
    }
    await refresh()
  }
  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await remove.mutateAsync({ versionId, id: deleting.id })
    } catch {
      return // shown by ErrorMessage via remove.error
    }
    setDeleting(null)
    await refresh()
  }

  return (
    <Section
      title={t('manual.title')}
      description={t('manual.description')}
      actions={
        canWrite ? (
          <>
            <Button variant="secondary" onClick={() => add('catalog')}>
              <Plus /> {t('manual.addCatalog')}
            </Button>
            <Button variant="secondary" onClick={() => add('freeText')}>
              <Plus /> {t('manual.addFreeText')}
            </Button>
          </>
        ) : undefined
      }
    >
      <ErrorMessage error={reorder.error} />
      <DataTable
        label={t('manual.title')}
        rows={lines}
        rowKey={(l) => l.id}
        empty={<EmptyState title={t('manual.empty')} />}
        columns={[
          {
            header: t('manual.columns.item'),
            mobile: 'title',
            cell: (l) => (
              <span>
                <span className="block font-medium">{lineName(l)}</span>
                <span className="text-xs text-muted">{l.kind === 'catalog' ? (l.snapshot?.modelNumber ?? t('manual.kindCatalog')) : t('manual.kindFreeText')}</span>
              </span>
            ),
          },
          { header: t('manual.columns.quantity'), className: 'text-right', cell: (l) => <span className="block text-right tabular-nums max-md:text-left">{l.quantity}</span> },
          { header: t('manual.columns.unitPrice'), className: 'text-right', cell: (l) => amount(l.unitPrice, l.converted?.unitPrice) },
          { header: t('manual.columns.total'), className: 'text-right', cell: (l) => amount(l.total, l.converted?.total) },
          { header: t('manual.columns.note'), cell: (l) => (l.note ? <span className="whitespace-pre-line text-muted">{l.note}</span> : null) },
        ]}
        actions={
          canWrite
            ? (l) => {
                const index = lines.indexOf(l)
                const name = lineName(l)
                return (
                  <>
                    <IconButton label={t('manual.moveUp', { name })} icon={<ChevronUp />} disabled={index === 0 || reorder.isPending} onClick={() => void move(index, -1)} />
                    <IconButton
                      label={t('manual.moveDown', { name })}
                      icon={<ChevronDown />}
                      disabled={index === lines.length - 1 || reorder.isPending}
                      onClick={() => void move(index, 1)}
                    />
                    <RowAction icon={<Pencil />} label={tCommon('action.edit')} aria-label={`${tCommon('action.edit')} ${name}`} onClick={() => setEditing(l.id)} />
                    <RowAction
                      icon={<Trash2 />}
                      variant="danger-quiet"
                      label={tCommon('action.delete')}
                      aria-label={`${tCommon('action.delete')} ${name}`}
                      onClick={() => {
                        remove.reset()
                        setDeleting(l)
                      }}
                    />
                  </>
                )
              }
            : undefined
        }
      />
      {canWrite && (
        <ManualLineDialog
          open={editing !== undefined}
          onOpenChange={(open) => !open && setEditing(undefined)}
          versionId={versionId}
          item={editItem}
          kind={newKind}
          productTypeIds={productTypeIds}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('manual.deleteTitle')}
        message={t('manual.deleteMessage', { name: deleting ? lineName(deleting) : '' })}
        confirmLabel={tCommon('action.delete')}
        pending={remove.isPending}
        onConfirm={() => void confirmDelete()}
        error={<ErrorMessage error={remove.error} />}
      />
    </Section>
  )
}
