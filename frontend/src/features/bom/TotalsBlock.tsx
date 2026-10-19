import { useTranslation } from 'react-i18next'

import type { PricingServicesLabel } from '@/api/generated/model'
import { useLocalized } from '@/i18n/localized'
import { cn } from '@/lib/cn'

import { type BomTotals, usd, useFormatMoney, useFormatRate } from './format'

type Props = {
  totals: BomTotals
  servicesLabel: PricingServicesLabel
  /** Heading of the block; default "Totals". */
  title?: string
  /** Dimmed while newer totals load (the pricing preview). */
  pending?: boolean
}

/**
 * Subtotal, discount, services and grand total as the API computed them, in
 * USD and, for another project currency, converted (each amount converted on
 * its own by the API, D228).
 */
export function TotalsBlock({ totals, servicesLabel, title, pending }: Props) {
  const { t } = useTranslation('bom')
  const localize = useLocalized()
  const money = useFormatMoney()
  const rate = useFormatRate()
  const converted = totals.converted
  const rows = [
    { key: 'subtotal', label: t('bom.totals.subtotal'), usd: totals.subtotal, local: converted?.subtotal },
    { key: 'discount', label: t('bom.totals.discount'), usd: `-${totals.discount}`, local: converted && `-${converted.discount}`, hidden: Number(totals.discount) === 0 },
    { key: 'services', label: localize(servicesLabel), usd: totals.services, local: converted?.services, hidden: Number(totals.services) === 0 },
    { key: 'grandTotal', label: t('bom.totals.grandTotal'), usd: totals.grandTotal, local: converted?.grandTotal, strong: true },
  ].filter((r) => !r.hidden)

  return (
    <section aria-label={title ?? t('bom.totals.title')} className={cn('ml-auto w-full max-w-md space-y-2 rounded-control border border-line bg-surface p-4', pending && 'opacity-60')} aria-busy={pending || undefined}>
      <h3 className="text-sm font-semibold">{title ?? t('bom.totals.title')}</h3>
      <dl className="space-y-1 text-sm">
        {rows.map((r) => (
          <div key={r.key} className={cn('flex items-baseline justify-between gap-4', r.strong && 'border-t border-line pt-1 font-semibold')} data-testid={`total-${r.key}`}>
            <dt className="min-w-0">{r.label}</dt>
            <dd className="text-right tabular-nums">
              {/* "-0.00" never reaches here: a zero discount is hidden. The sign is display only. */}
              <span className="whitespace-nowrap">{money(r.usd, usd)}</span>
              {r.local != null && <span className="block text-xs whitespace-nowrap text-muted">{money(r.local, totals.currency)}</span>}
            </dd>
          </div>
        ))}
      </dl>
      {converted && <p className="text-xs text-muted">{t('bom.totals.rate', { rate: rate(totals.rate), currency: totals.currency })}</p>}
    </section>
  )
}
