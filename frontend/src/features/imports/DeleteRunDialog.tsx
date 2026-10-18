import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { getGetImportQueryKey, getListImportsQueryKey, useDeleteImport } from '@/api/generated/imports/imports'
import type { ImportRun } from '@/api/generated/model'
import { ConfirmDialog, ErrorMessage, Notice } from '@/components/ui'

import { isStateError } from './run-reload'

type DeleteRunDialogProps = {
  /** The run to delete; null closes the dialog. */
  run: ImportRun | null
  onClose: () => void
  onDeleted: () => void
}

/** Asks before deleting a run (D150); an applied run must be undone first. */
export function DeleteRunDialog({ run, onClose, onDeleted }: DeleteRunDialogProps) {
  const { t } = useTranslation('imports')
  const { t: tCommon } = useTranslation()
  const queryClient = useQueryClient()
  const remove = useDeleteImport()
  const { reset } = remove
  // Each delete starts without the previous attempt's error.
  useEffect(() => reset(), [run?.id, reset])

  const confirm = async () => {
    if (!run) return
    try {
      await remove.mutateAsync({ id: run.id })
    } catch (e) {
      // Applied meanwhile: the list and the run show it.
      if (isStateError(e)) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getListImportsQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getGetImportQueryKey(run.id) }),
        ])
      }
      return
    }
    onDeleted()
    queryClient.removeQueries({ queryKey: getGetImportQueryKey(run.id) })
    await queryClient.invalidateQueries({ queryKey: getListImportsQueryKey() })
  }

  return (
    <ConfirmDialog
      open={run !== null}
      onOpenChange={(open) => !open && onClose()}
      title={t('delete.title')}
      message={t('delete.message', { name: run?.fileName || t('noFileName') })}
      confirmLabel={tCommon('action.delete')}
      pending={remove.isPending}
      onConfirm={() => void confirm()}
      error={isStateError(remove.error) ? <Notice tone="warning">{t('delete.applied')}</Notice> : <ErrorMessage error={remove.error} />}
    />
  )
}
