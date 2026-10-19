import { useQueryClient } from '@tanstack/react-query'
import { BookOpen, Download, Tags, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { getListDocumentsQueryKey, useDeleteDocument, useGenerateDocument, useListDocuments } from '@/api/generated/installation/installation'
import type { DocumentInputKind, GeneratedDocument } from '@/api/generated/model'
import { Button, ConfirmDialog, DataTable, DownloadLink, EmptyState, ErrorMessage, Loading, Notice, RowAction, Section } from '@/components/ui'
import { startDownload, useFormatDateTime, useLanguageName } from '@/features/proposals'

type Props = {
  versionId: string
  /** projects.write: generating works on completed projects too, like proposals (D420). */
  canGenerate: boolean
}

/** Always fetched again: another user may have generated or deleted one. */
const fresh = { staleTime: 0, refetchOnMount: 'always' } as const

/**
 * Installation manual and channel labels of a version (3e, D420): two
 * buttons that generate a DOCX (the API renders it, the browser downloads
 * it) and the list of generated documents, newest first.
 */
export function InstallationDocumentsSection({ versionId, canGenerate }: Props) {
  const { t } = useTranslation('installation')
  const { t: tCommon } = useTranslation()
  const formatDate = useFormatDateTime()
  const languageName = useLanguageName()
  const queryClient = useQueryClient()
  const query = useListDocuments(versionId, { query: fresh })
  const generate = useGenerateDocument()
  const remove = useDeleteDocument()
  const [created, setCreated] = useState<GeneratedDocument | null>(null)
  const [deleting, setDeleting] = useState<GeneratedDocument | null>(null)
  const refresh = () => queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey(versionId) })

  const run = async (kind: DocumentInputKind) => {
    setCreated(null)
    let doc: GeneratedDocument
    try {
      doc = await generate.mutateAsync({ versionId, data: { kind } })
    } catch {
      return // shown by ErrorMessage via generate.error
    }
    setCreated(doc)
    startDownload(doc.downloadUrl)
    await refresh()
  }

  const openDelete = (d: GeneratedDocument | null) => {
    remove.reset()
    setDeleting(d)
  }
  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await remove.mutateAsync({ id: deleting.id })
    } catch {
      return // shown in the dialog
    }
    if (created?.id === deleting.id) setCreated(null)
    setDeleting(null)
    await refresh()
  }

  const busy = generate.isPending
  const pendingKind = busy ? generate.variables?.data.kind : undefined

  return (
    <Section
      title={t('documents.title')}
      description={t('documents.description')}
      actions={
        canGenerate ? (
          <>
            <Button variant="secondary" disabled={busy} aria-busy={pendingKind === 'installation_manual'} onClick={() => void run('installation_manual')}>
              <BookOpen aria-hidden /> {t('documents.manual')}
            </Button>
            <Button variant="secondary" disabled={busy} aria-busy={pendingKind === 'channel_labels'} onClick={() => void run('channel_labels')}>
              <Tags aria-hidden /> {t('documents.labels')}
            </Button>
          </>
        ) : undefined
      }
    >
      {generate.error && <ErrorMessage error={generate.error} />}
      {busy && <Loading />}
      {created && (
        <Notice>
          {t('documents.created', { number: created.number })} <DownloadLink href={created.downloadUrl}>{created.fileName}</DownloadLink>
        </Notice>
      )}
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorMessage error={query.error} />
      ) : (
        <DataTable
          label={t('documents.title')}
          rows={query.data}
          rowKey={(d) => d.id}
          columns={[
            { header: t('documents.column.number'), cell: (d) => <span className="font-medium whitespace-nowrap">{d.number}</span>, mobile: 'title' },
            { header: t('documents.column.kind'), cell: (d) => t(`documents.kind.${d.kind}`) },
            { header: t('documents.column.createdAt'), cell: (d) => formatDate(d.createdAt), className: 'whitespace-nowrap' },
            { header: t('documents.column.language'), cell: (d) => languageName(d.language) },
            { header: t('documents.column.createdBy'), cell: (d) => d.createdByName || t('documents.deletedUser') },
          ]}
          actions={(d) => (
            <>
              <RowAction download={d.downloadUrl} icon={<Download />} label={t('documents.download')} />
              {d.can.delete && <RowAction variant="danger-quiet" onClick={() => openDelete(d)} icon={<Trash2 />} label={tCommon('action.delete')} />}
            </>
          )}
          empty={<EmptyState title={canGenerate ? t('documents.emptyHint') : t('documents.empty')} />}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && openDelete(null)}
        title={t('documents.deleteTitle')}
        message={t('documents.deleteMessage', { number: deleting?.number ?? '' })}
        confirmLabel={tCommon('action.delete')}
        pending={remove.isPending}
        onConfirm={() => void confirmDelete()}
        error={<ErrorMessage error={remove.error} />}
      />
    </Section>
  )
}
