import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type { ImportCounts } from '@/api/generated/model'
import { Badge, TextLink } from '@/components/ui'
import { cn } from '@/lib/cn'

type Line = { label: string; value: number; tone?: 'danger' | 'warning'; to?: string }

function Card({ title, lines }: { title: string; lines: Line[] }) {
  return (
    <div className="rounded-control border border-line bg-surface p-3 sm:p-4">
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      <dl className="space-y-1 text-sm">
        {lines.map((l) => (
          <div key={l.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-muted">
              {l.to && l.value > 0 ? (
                // Named with its card: "Unchanged" alone is in two cards.
                <TextLink to={l.to} aria-label={`${title}: ${l.label}`}>
                  {l.label}
                </TextLink>
              ) : (
                l.label
              )}
            </dt>
            <dd
              className={cn(
                'font-medium tabular-nums',
                l.value > 0 && l.tone === 'danger' && 'text-danger',
                l.value > 0 && l.tone === 'warning' && 'text-warning',
                l.value === 0 && 'text-muted',
              )}
            >
              {l.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

type CountersProps = {
  counts: ImportCounts
  /** Links of the counters to the diff filtered by them (preview only), by entity and status ("skipped": rows with errors). */
  filterHref?: (entity: string, status: string) => string
  /** Links to the issues of a severity. */
  issuesHref?: (severity: string) => string
  /** After the apply the counters say what was written, not what will be. */
  applied?: boolean
  extra?: ReactNode
}

/** What a preview found or an apply wrote: categories, products, variants, add-ons, pictures and rows. */
export function Counters({ counts, filterHref, issuesHref, applied, extra }: CountersProps) {
  const { t } = useTranslation('imports')
  const entity = (name: 'products' | 'variants', key: 'product' | 'variant') => (
    <Card
      title={t(`counts.${name}`)}
      lines={(['new', 'changed', 'unchanged', 'deactivate'] as const).map((s) => ({
        label: t(applied ? `counts.done.${s}` : `counts.${s}`),
        value: counts[name][s],
        tone: s === 'deactivate' ? ('warning' as const) : undefined,
        to: filterHref?.(key, s),
      }))}
    />
  )
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
        {entity('products', 'product')}
        {entity('variants', 'variant')}
        <Card
          title={t('counts.addons')}
          lines={[
            { label: t(applied ? 'counts.done.addonsNew' : 'counts.addonsNew'), value: counts.addons.new },
            { label: t('counts.addonsChanged'), value: counts.addons.changed },
            { label: t('counts.unchanged'), value: counts.addons.unchanged },
            { label: t('counts.addonsRemoved'), value: counts.addons.removed, tone: 'warning' },
            // Unresolved references are warnings (import.addon_not_found): the only filter the API has for them.
            { label: t('counts.addonsUnresolved'), value: counts.addons.unresolved, tone: 'warning', to: issuesHref?.('warning') },
          ]}
        />
        <Card
          title={t('counts.images')}
          lines={[
            { label: t('counts.imagesNew'), value: counts.images.new },
            { label: t('counts.imagesChanged'), value: counts.images.changed },
            { label: t('counts.unchanged'), value: counts.images.unchanged },
            { label: t('counts.imagesFiles'), value: counts.images.files },
          ]}
        />
        <Card
          title={t('counts.rows')}
          lines={[
            { label: t('counts.rowsRead'), value: counts.rows },
            { label: t('counts.newCategories'), value: counts.categories.new, to: filterHref?.('category', 'new') },
            { label: t('counts.errors'), value: counts.errors, tone: 'danger', to: issuesHref?.('error') },
            { label: t('counts.warnings'), value: counts.warnings, tone: 'warning', to: issuesHref?.('warning') },
            { label: t('counts.rowsSkipped'), value: counts.rowsSkipped, tone: 'danger', to: filterHref?.('', 'skipped') },
          ]}
        />
      </div>
      {counts.unmapped.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-muted">{t('counts.unmapped', { count: counts.unmapped.length })}</span>
          {counts.unmapped.map((c) => (
            <Badge key={c.letter}>{c.header ? `${c.letter} · ${c.header}` : c.letter}</Badge>
          ))}
        </div>
      )}
      {extra}
    </div>
  )
}
