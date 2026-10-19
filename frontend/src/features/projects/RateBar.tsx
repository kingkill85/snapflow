import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { Pencil, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { getGetBomQueryKey, getListManualLinesQueryKey } from '@/api/generated/bom/bom'
import type { Project } from '@/api/generated/model'
import { getGetProjectQueryKey, useRefreshProjectExchangeRate, useSetProjectExchangeRate } from '@/api/generated/projects/projects'
import { decimalSeparator, formatDecimal, parseDecimal } from '@/catalog/decimal'
import { apiFields, Button, ErrorMessage, errorKey, Field, FormDialog, Notice, setApiFieldErrors, useFieldError } from '@/components/ui'

import { useFormatRateDate } from './currency'

/** The rate as the API sends it, with the UI language's digits ("0,9237"). */
function useFormatRate() {
  const { i18n } = useTranslation()
  const format = new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en', { maximumFractionDigits: 10 })
  return (value: string) => format.format(value as Intl.StringNumericLiteral)
}

type Props = {
  project: Project
  /** The version whose BOM and totals refresh after a change. */
  versionId: string
}

/**
 * The exchange rate of a non-USD project above the BOM and Pricing tabs:
 * the rate with its origin (online and the provider's date, or entered
 * manually), "No exchange rate yet" without one, a warning when an online
 * rate is older than the server's limit (manual rates are deliberate: never),
 * and Update rate (online) / Set rate (manual) for writers. After a change
 * the BOM and totals load again (D44).
 */
export function RateBar({ project, versionId }: Props) {
  const { t } = useTranslation('projects')
  const queryClient = useQueryClient()
  const rate = useFormatRate()
  const date = useFormatRateDate()
  const refresh = useRefreshProjectExchangeRate()
  const [setting, setSetting] = useState(false)
  if (project.currency === 'USD') return null

  const saved = async (p: Project) => {
    queryClient.setQueryData(getGetProjectQueryKey(p.id), p)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetBomQueryKey(versionId) }),
      queryClient.invalidateQueries({ queryKey: getListManualLinesQueryKey(versionId) }),
      queryClient.invalidateQueries({ queryKey: ['pricing-preview', versionId] }),
    ])
  }
  const update = async () => {
    try {
      await saved(await refresh.mutateAsync({ id: project.id }))
    } catch {
      return // shown by ErrorMessage via refresh.error
    }
  }

  const has = project.exchangeRate != null
  const origin =
    has && project.exchangeRateDate
      ? project.exchangeRateSource === 'online'
        ? t('rate.online', { date: date(project.exchangeRateDate) })
        : t('rate.manual', { date: date(project.exchangeRateDate) })
      : undefined
  return (
    <div className="space-y-2" data-testid="rate-bar">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-line bg-surface px-3 py-2 text-sm">
        <p>
          {has ? (
            <>
              <span className="font-medium">{t('rate.value', { rate: rate(project.exchangeRate!), currency: project.currency })}</span>
              {origin && <span className="text-muted"> · {origin}</span>}
            </>
          ) : (
            <span className="text-muted">{t('rate.none')}</span>
          )}
        </p>
        {project.can.update && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={refresh.isPending} onClick={() => void update()}>
              <RefreshCw aria-hidden="true" />
              {t('rate.update')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setSetting(true)}>
              <Pencil aria-hidden="true" />
              {t('rate.set')}
            </Button>
          </div>
        )}
      </div>
      {has && project.exchangeRateSource === 'online' && project.exchangeRateStale && (
        <Notice tone="warning">{t('rate.stale', { count: project.exchangeRateAgeDays, max: project.exchangeRateMaxAgeDays })}</Notice>
      )}
      <ErrorMessage error={refresh.error} />
      {project.can.update && <SetRateDialog open={setting} onOpenChange={setSetting} project={project} onSaved={saved} />}
    </div>
  )
}

const schema = z.object({
  rate: z.string().refine((v) => Number(parseDecimal(v) ?? 0) > 0, errorKey('project.exchange_rate')),
})
type FormValues = z.infer<typeof schema>
const fields = apiFields<FormValues>(['rate'])

/** Enters the rate by hand (marked manual; never replaced automatically). */
function SetRateDialog({ open, onOpenChange, project, onSaved }: { open: boolean; onOpenChange: (open: boolean) => void; project: Project; onSaved: (p: Project) => Promise<void> }) {
  const { t, i18n } = useTranslation('projects')
  const { t: tCommon } = useTranslation()
  const fieldError = useFieldError()
  const set = useSetProjectExchangeRate()
  const form = useForm<FormValues>({ resolver: zodResolver(schema) })
  const { reset } = form
  const { reset: resetSet } = set
  useEffect(() => {
    if (!open) return
    reset({ rate: formatDecimal(project.exchangeRate ?? '', decimalSeparator(i18n.resolvedLanguage ?? 'en')) })
    resetSet()
    // Only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reset, resetSet])

  const submit = form.handleSubmit(async (v) => {
    try {
      const p = await set.mutateAsync({ id: project.id, data: { rate: parseDecimal(v.rate) ?? v.rate } })
      onOpenChange(false)
      await onSaved(p)
    } catch (error) {
      setApiFieldErrors(error, form.setError, fields)
    }
  })

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('rate.setTitle')}
      submitLabel={tCommon('action.update')}
      submitting={set.isPending}
      onSubmit={() => void submit()}
      error={<ErrorMessage error={set.error} fields={fields} />}
    >
      <Field
        label={t('field.exchangeRate')}
        hint={t('rate.setHint', { currency: project.currency })}
        inputMode="decimal"
        autoComplete="off"
        required
        error={fieldError(form.formState.errors.rate?.message)}
        {...form.register('rate')}
      />
    </FormDialog>
  )
}
