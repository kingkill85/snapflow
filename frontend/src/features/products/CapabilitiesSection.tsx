import { TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { Product } from '@/api/generated/model'
import { useMissingText } from '@/catalog/readiness'
import { Section } from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

import { useDescribeCapabilities } from './describe-capabilities'

/**
 * "What SnapFlow knows about this product": the capabilities the backend
 * computes from the attribute values linked to catalog field meanings, for
 * the product and each variant, in plain words (spec 3a). Read-only.
 */
export function CapabilitiesSection({ product }: { product: Product }) {
  const { t } = useTranslation('products')
  const localized = useLocalized()
  const describe = useDescribeCapabilities()
  const missingText = useMissingText()
  const missing = product.capabilities.missing ?? []
  const rows = [
    { key: 'product', title: t('capabilities.product'), text: describe(product.capabilities) },
    ...product.variants.map((v) => ({ key: v.id, title: localized(v.name), text: describe(v.capabilities) })),
  ]
  return (
    <Section title={t('capabilities.title')} description={t('capabilities.hint')}>
      <dl className="space-y-3" data-testid="capabilities">
        {rows.map((r) => (
          <div key={r.key} className="space-y-0.5">
            <dt className="text-sm font-medium">{r.title}</dt>
            <dd className="text-sm text-muted">{r.text}</dd>
          </div>
        ))}
      </dl>
      {/* What the checks still need (D447): the product's and its active variants' gaps. */}
      {missing.length > 0 && (
        <div className="space-y-1.5" data-testid="still-missing">
          <h3 className="text-sm font-medium">{t('capabilities.missing')}</h3>
          <ul className="space-y-1">
            {missing.map((m) => (
              <li key={m.code} className="flex items-start gap-2 text-sm">
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
                <span>{missingText(m.code)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  )
}
