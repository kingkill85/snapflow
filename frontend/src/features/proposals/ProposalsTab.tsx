import { useQueryClient } from '@tanstack/react-query'
import { Download, FilePlus2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'

import { useGetBom } from '@/api/generated/bom/bom'
import type { Proposal } from '@/api/generated/model'
import { getListProposalsQueryKey, useDeleteProposal, useListProposals } from '@/api/generated/proposals/proposals'
import { Button, ConfirmDialog, DataTable, DownloadLink, EmptyState, ErrorMessage, Loading, Notice, RowAction, Section, TextLink, TypeBadge } from '@/components/ui'
import { fresh } from '@/features/bom/format'
import { useLocalized } from '@/i18n/localized'

import { CreateProposalDialog } from './CreateProposalDialog'
import { useFormatDateTime, useFormatGrandTotal, useLanguageName } from './format'

type Props = {
  versionId: string
  /** projects.write: generating is allowed on read-only (completed, cancelled) projects too (D259). */
  canGenerate: boolean
}

/**
 * The Proposals tab of a version (2d): the generated documents, newest first,
 * with download and delete, and "Create proposal". The documents are built by
 * the API; this tab only lists them.
 */
export function ProposalsTab({ versionId, canGenerate }: Props) {
  const { t } = useTranslation('proposals')
  const { t: tCommon } = useTranslation()
  const localize = useLocalized()
  const formatDate = useFormatDateTime()
  const grandTotal = useFormatGrandTotal()
  const languageName = useLanguageName()
  const queryClient = useQueryClient()
  const query = useListProposals(versionId, { query: fresh })
  // The BOM's product types give the badges their colour and abbreviation and the dialog its choices.
  const bom = useGetBom(versionId)
  const remove = useDeleteProposal()
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<Proposal | null>(null)
  const [created, setCreated] = useState<Proposal[]>([])

  // A non-USD project without a rate: no proposal until it is set (D274) on the Pricing tab.
  const rateMissing = !!bom.data && bom.data.totals.currency !== 'USD' && bom.data.totals.rate === ''
  const [params] = useSearchParams()
  const pricingTab = new URLSearchParams(params)
  pricingTab.set('tab', 'pricing')

  const types = (bom.data?.groups ?? []).flatMap((g) => (g.productType ? [g.productType] : []))
  const refresh = () => queryClient.invalidateQueries({ queryKey: getListProposalsQueryKey(versionId) })

  const openDelete = (p: Proposal | null) => {
    remove.reset()
    setDeleting(p)
  }
  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await remove.mutateAsync({ id: deleting.id })
    } catch {
      return // shown by ErrorMessage via remove.error
    }
    setDeleting(null)
    setCreated((list) => list.filter((p) => p.id !== deleting.id))
    await refresh()
  }

  const documentType = (p: Proposal) => {
    if (!p.productType) return t('combined')
    const type = types.find((ty) => ty.id === p.productType?.id)
    return (
      <TypeBadge color={type?.color} abbreviation={type?.abbreviation} wrap>
        {localize(p.productType.name)}
      </TypeBadge>
    )
  }

  return (
    <Section
      title={t('title')}
      description={t('description')}
      actions={
        canGenerate ? (
          <Button disabled={rateMissing} onClick={() => setCreating(true)}>
            <FilePlus2 /> {t('create')}
          </Button>
        ) : undefined
      }
    >
      {rateMissing && (
        <Notice tone="warning">
          {t('rateMissing', { currency: bom.data!.totals.currency })} <TextLink to={`?${pricingTab.toString()}`}>{t('rateMissingLink')}</TextLink>
        </Notice>
      )}
      {created.length > 0 && (
        <Notice>
          {t('created', { count: created.length, numbers: created.map((p) => p.number).join(', ') })}{' '}
          {/* A fallback: browsers may block downloads that a script starts. */}
          {t('downloadFallback', { count: created.length })}{' '}
          {created.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ', '}
              <DownloadLink href={p.downloadUrl}>{p.number}</DownloadLink>
            </span>
          ))}
        </Notice>
      )}
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorMessage error={query.error} />
      ) : (
        <DataTable
          label={t('title')}
          rows={query.data}
          rowKey={(p) => p.id}
          columns={[
            { header: t('column.number'), cell: (p) => <span className="font-medium whitespace-nowrap">{p.number}</span>, mobile: 'title' },
            { header: t('column.createdAt'), cell: (p) => formatDate(p.createdAt), className: 'whitespace-nowrap' },
            { header: t('column.type'), cell: documentType },
            { header: t('column.language'), cell: (p) => languageName(p.language) },
            { header: t('column.grandTotal'), cell: (p) => grandTotal(p.totals), className: 'whitespace-nowrap text-right tabular-nums' },
            { header: t('column.createdBy'), cell: (p) => p.createdByName || t('deletedUser') },
          ]}
          actions={(p) => (
            <>
              <RowAction download={p.downloadUrl} icon={<Download />} label={t('download')} />
              {p.can.delete && <RowAction variant="danger-quiet" onClick={() => openDelete(p)} icon={<Trash2 />} label={tCommon('action.delete')} />}
            </>
          )}
          empty={<EmptyState title={canGenerate ? t('emptyHint') : t('empty')} />}
        />
      )}

      {/* Mounted while open: each opening starts from fresh choices. */}
      {canGenerate && creating && (
        <CreateProposalDialog
          open={creating}
          onOpenChange={setCreating}
          versionId={versionId}
          productTypes={types}
          onCreated={(list) => {
            setCreated(list)
            void refresh()
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && openDelete(null)}
        title={t('deleteTitle')}
        message={t('deleteMessage', { number: deleting?.number ?? '' })}
        confirmLabel={tCommon('action.delete')}
        pending={remove.isPending}
        onConfirm={() => void confirmDelete()}
        error={<ErrorMessage error={remove.error} />}
      />
    </Section>
  )
}
