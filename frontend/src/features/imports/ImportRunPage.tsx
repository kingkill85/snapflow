import { ArrowLeft, Download, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'

import { ApiError } from '@/api/client'
import { useGetImport } from '@/api/generated/imports/imports'
import { fileUrl } from '@/catalog/files'
import { Button, EmptyState, ErrorMessage, Loading, Page, TextLink } from '@/components/ui'

import { MappingStep } from './MappingStep'
import { listPath, profileParam, useFormatBytes, useFormatDateTime } from './paths'
import { PreviewStep } from './PreviewStep'
import { ResultStep } from './ResultStep'
import { DeleteRunDialog } from './DeleteRunDialog'
import { type Step, StepIndicator } from './StepIndicator'
import { RunStateBadge } from './values'

/** catalog/imports/:id: one run, its step chosen by its state (and "Edit mapping"). */
export function ImportRunPage() {
  const { id = '' } = useParams()
  const { t } = useTranslation('imports')
  const { t: tCommon } = useTranslation()
  const navigate = useNavigate()
  const formatDate = useFormatDateTime()
  const formatBytes = useFormatBytes()
  const [params, setParams] = useSearchParams()
  // Fetched again on focus while uploaded: another tab may have previewed it meanwhile.
  const run = useGetImport(id, { query: { staleTime: 0, refetchOnWindowFocus: (q) => q.state.data?.state === 'uploaded' } })
  const editing = params.get('view') === 'mapping'
  // "All or nothing" as last chosen in the preview, for the mapping edited from there.
  const [allOrNothing, setAllOrNothing] = useState<boolean>()
  const [deleting, setDeleting] = useState(false)
  // Leaving the mapping or the preview starts the lists of the next step on their first page.
  const showStep = (view?: 'mapping') => setParams(view ? { view } : {}, { replace: false })

  const back = (
    <Button asChild variant="secondary">
      <Link to={listPath}>
        <ArrowLeft /> {t('backToList')}
      </Link>
    </Button>
  )

  if (run.isPending) {
    return (
      <Page title={t('title')}>
        <Loading />
      </Page>
    )
  }
  if (run.isError) {
    const missing = run.error instanceof ApiError && (run.error.status === 404 || run.error.status === 422)
    return (
      <Page title={t('title')} actions={back}>
        {missing ? <EmptyState title={t('notFound')} /> : <ErrorMessage error={run.error} />}
      </Page>
    )
  }

  const r = run.data
  const mapping = r.state === 'uploaded' || r.state === 'failed' || (r.state === 'previewed' && editing)
  const step: Step = mapping ? 'mapping' : r.state === 'previewed' ? 'preview' : 'result'
  // The profile chosen with the upload stays in the URL until its preview settled (a reload starts it again).
  const autoProfileId = r.state === 'uploaded' ? (params.get(profileParam) ?? undefined) : undefined

  return (
    <Page
      width="wide"
      title={r.fileName || t('noFileName')}
      description={t('run.meta', { user: r.userName, date: formatDate(r.createdAt), size: formatBytes(r.fileSize) })}
      actions={
        <>
          {back}
          {/* Not while applied: undo first (D150). */}
          {r.can.delete && (
            <Button variant="danger-quiet" onClick={() => setDeleting(true)}>
              <Trash2 /> {tCommon('action.delete')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StepIndicator current={step} />
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <TextLink to={fileUrl(r.fileId)!} reloadDocument download={r.fileName || true} className="inline-flex items-center gap-1 [&_svg]:size-4">
            <Download aria-hidden="true" /> {t('run.download')}
          </TextLink>
          <RunStateBadge state={r.state} />
        </div>
      </div>
      {mapping ? (
        <MappingStep
          key={`${r.id}-${r.state}`}
          run={r}
          autoProfileId={autoProfileId}
          onAutoSettled={() =>
            setParams(
              (prev) => {
                const next = new URLSearchParams(prev)
                next.delete(profileParam)
                return next
              },
              { replace: true },
            )
          }
          allOrNothing={r.state === 'previewed' ? allOrNothing : undefined}
          onPreviewed={() => showStep()}
          onCancel={r.state === 'previewed' ? () => showStep() : undefined}
        />
      ) : r.state === 'previewed' ? (
        <PreviewStep
          run={r}
          onEditMapping={(value) => {
            setAllOrNothing(value)
            showStep('mapping')
          }}
          onApplied={() => showStep()}
        />
      ) : (
        <ResultStep run={r} />
      )}
      <DeleteRunDialog run={deleting ? r : null} onClose={() => setDeleting(false)} onDeleted={() => void navigate(listPath, { replace: true })} />
    </Page>
  )
}
