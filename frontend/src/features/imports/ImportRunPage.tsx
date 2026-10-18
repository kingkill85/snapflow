import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useParams, useSearchParams } from 'react-router'

import { ApiError } from '@/api/client'
import { useGetImport } from '@/api/generated/imports/imports'
import { Button, EmptyState, ErrorMessage, Loading, Page } from '@/components/ui'

import { RunStateBadge } from './values'
import { MappingStep } from './MappingStep'
import { listPath, profileIdFrom, useFormatBytes, useFormatDateTime } from './paths'
import { PreviewStep } from './PreviewStep'
import { ResultStep } from './ResultStep'
import { type Step, StepIndicator } from './StepIndicator'

/** catalog/imports/:id: one run, its step chosen by its state (and "Edit mapping"). */
export function ImportRunPage() {
  const { id = '' } = useParams()
  const { t } = useTranslation('imports')
  const location = useLocation()
  const formatDate = useFormatDateTime()
  const formatBytes = useFormatBytes()
  const [params, setParams] = useSearchParams()
  const run = useGetImport(id, { query: { staleTime: 0, refetchOnWindowFocus: false } })
  const editing = params.get('view') === 'mapping'
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

  return (
    <Page
      width="wide"
      title={r.fileName || t('noFileName')}
      description={t('run.meta', { user: r.userName, date: formatDate(r.createdAt), size: formatBytes(r.fileSize) })}
      actions={back}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StepIndicator current={step} />
        <RunStateBadge state={r.state} />
      </div>
      {mapping ? (
        <MappingStep
          key={`${r.id}-${r.state}`}
          run={r}
          autoProfileId={r.state === 'uploaded' ? profileIdFrom(location.state) : undefined}
          onPreviewed={() => showStep()}
          onCancel={r.state === 'previewed' ? () => showStep() : undefined}
        />
      ) : r.state === 'previewed' ? (
        <PreviewStep run={r} onEditMapping={() => showStep('mapping')} onApplied={() => showStep()} />
      ) : (
        <ResultStep run={r} />
      )}
    </Page>
  )
}
