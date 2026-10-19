import { MapPin } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { FunctionTypeTotal, LoadTypeTotal, NeedTotals, SummaryZone } from '@/api/generated/model'
import { useGetVersionNeeds } from '@/api/generated/plans/plans'
import { Badge, type Column, DataTable, EmptyState, ErrorMessage, Loading, Section } from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { useFormatWatts, useNeedText, useNeedTotalsText } from './format'

/** Needs change in the plan editor: fetched on every visit. */
const everyVisit = { staleTime: 0, refetchOnMount: 'always' } as const

/**
 * The read-only "Needs by room" overview of a version (step 3b): plan → zone
 * → need lines in plain words with the API's totals per zone and plan, then
 * the totals per function type and per load type (rule 1: no client maths).
 */
export function NeedsTab({ versionId }: { versionId: string }) {
  const { t } = useTranslation('needs')
  const totalsText = useNeedTotalsText()
  const query = useGetVersionNeeds(versionId, { query: everyVisit })

  if (query.isError) return <ErrorMessage error={query.error} />
  if (query.isPending) return <Loading />
  const summary = query.data

  if (summary.plans.length === 0) return <EmptyState title={t('overview.empty')} />

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t('overview.title')}</h2>
        <p className="text-sm text-muted">{t('overview.description')}</p>
        <p className="text-sm font-medium">
          {t('overview.total')}: {totalsText(summary.totals)}
        </p>
      </div>

      {summary.plans.map((plan) => (
        <Section key={plan.planId} title={plan.name} description={totalsText(plan.totals)}>
          <div className="space-y-5">
            {plan.zones.map((zone) => (
              <ZoneNeeds key={zone.zoneId ?? 'none'} zone={zone} />
            ))}
          </div>
        </Section>
      ))}

      <Section title={t('overview.byFunctionType')}>
        <TotalsTable
          label={t('overview.byFunctionType')}
          header={t('overview.columns.functionType')}
          rows={summary.functionTypes}
          rowKey={(r) => r.functionType.id}
          name={(r, localize) => localize(r.functionType.name)}
        />
      </Section>
      <Section title={t('overview.byLoadType')}>
        <TotalsTable
          label={t('overview.byLoadType')}
          header={t('overview.columns.loadType')}
          rows={summary.loadTypes}
          rowKey={(r) => r.loadType?.id ?? 'none'}
          name={(r, localize) => (r.loadType ? localize(r.loadType.name) : t('overview.noLoadType'))}
        />
      </Section>
    </div>
  )
}

/** One zone's needs: name and totals, then one line per need. */
function ZoneNeeds({ zone }: { zone: SummaryZone }) {
  const { t } = useTranslation('needs')
  const needText = useNeedText()
  const totalsText = useNeedTotalsText()
  const name = zone.zoneId ? zone.name : t('overview.noZone')
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line pb-1">
        <h3 className="font-medium">{name}</h3>
        <span className="text-sm whitespace-nowrap text-muted tabular-nums">{totalsText(zone.totals)}</span>
      </div>
      <ul aria-label={name} className="space-y-2">
        {zone.needs.map((n) => (
          <li key={n.id} className="space-y-0.5 text-sm">
            <span className="flex flex-wrap items-center gap-2">
              <span className="break-words">
                {needText({
                  quantity: n.quantity,
                  functionTypeName: n.functionType.name,
                  powerW: n.powerW,
                  loadTypeName: n.loadType?.name,
                  label: n.label,
                })}
              </span>
              {n.symbol && (
                <Badge title={t('overview.symbolHint')}>
                  <MapPin className="size-3" aria-hidden /> {t('overview.symbol')}
                </Badge>
              )}
            </span>
            {n.note && <p className="text-xs break-words whitespace-pre-line text-muted">{n.note}</p>}
          </li>
        ))}
      </ul>
    </div>
  )
}

function TotalsTable<T extends FunctionTypeTotal | LoadTypeTotal>({
  label,
  header,
  rows,
  rowKey,
  name,
}: {
  label: string
  header: string
  rows: T[]
  rowKey: (row: T) => string
  name: (row: T, localize: ReturnType<typeof useLocalized>) => string
}) {
  const { t } = useTranslation('needs')
  const localize = useLocalized()
  const watts = useFormatWatts()
  const number = (value: string) => <span className="block text-right whitespace-nowrap tabular-nums max-md:text-left">{value}</span>
  const columns: Column<T>[] = [
    { header, mobile: 'title', cell: (r) => name(r, localize) },
    { header: t('overview.columns.quantity'), className: 'w-px text-right', cell: (r) => number(String(totalsOf(r).quantity)) },
    {
      header: t('overview.columns.power'),
      className: 'w-px text-right',
      cell: (r) => (totalsOf(r).powerW > 0 ? number(t('line.power', { power: watts(totalsOf(r).powerW) })) : null),
    },
  ]
  return <DataTable label={label} rows={rows} columns={columns} rowKey={rowKey} empty={null} />
}

const totalsOf = (r: FunctionTypeTotal | LoadTypeTotal): NeedTotals => r.totals

