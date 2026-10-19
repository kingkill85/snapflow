import { useTranslation } from 'react-i18next'

import { useListLoadTypes } from '@/api/generated/load-types/load-types'
import type { Capabilities, Product } from '@/api/generated/model'
import { useListOutputKinds } from '@/api/generated/output-kinds/output-kinds'
import { formatDecimal, useDecimalSeparator } from '@/catalog/decimal'
import { Section } from '@/components/ui'
import { useLocalized } from '@/i18n/localized'

/**
 * "What SnapFlow knows about this product": the capabilities the backend
 * computes from the attribute values linked to catalog field meanings, for
 * the product and each variant, in plain words (spec 3a). Read-only.
 */
export function CapabilitiesSection({ product }: { product: Product }) {
  const { t } = useTranslation('products')
  const localized = useLocalized()
  const describe = useDescribeCapabilities()
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
    </Section>
  )
}

/** Capabilities as one line of plain words ("6 × Dimmer output · max 200 W LED · … · mounting: board"). */
export function useDescribeCapabilities() {
  const { t } = useTranslation('products')
  const localized = useLocalized()
  const separator = useDecimalSeparator()
  const kinds = useListOutputKinds({ includeInactive: true }).data?.items ?? []
  const loads = useListLoadTypes({ includeInactive: true }).data?.items ?? []
  const kindName = (id: string, key: string) => {
    const kind = kinds.find((k) => k.id === id)
    return kind ? localized(kind.name) : key
  }
  const loadName = (id: string, key: string) => {
    const load = loads.find((l) => l.id === id)
    return load ? localized(load.name) : key
  }
  const n = (v: number) => formatDecimal(v, separator)

  return (c: Capabilities) => {
    const parts: string[] = []
    for (const ch of c.channels) {
      const channel = [t('capabilities.channels', { n: ch.count, kind: kindName(ch.outputKindId, ch.outputKindKey) })]
      if (ch.limitsW.length > 0) {
        const limits = ch.limitsW.map((l) => t('capabilities.limitW', { w: n(l.maxW), load: loadName(l.loadTypeId, l.loadTypeKey) }))
        channel.push(t('capabilities.max', { limits: limits.join(', ') }))
      }
      if (ch.limitA !== undefined) channel.push(t('capabilities.limitA', { a: n(ch.limitA) }))
      if (ch.minLoadW !== undefined) channel.push(t('capabilities.minLoad', { w: n(ch.minLoadW) }))
      for (const alt of ch.alternatives) {
        channel.push(t('capabilities.alternative', { max: alt.max, per: alt.per, kind: kindName(alt.outputKindId, alt.outputKindKey) }))
      }
      parts.push(channel.join(', '))
    }
    if (c.moduleTotalA !== undefined) parts.push(t('capabilities.moduleTotalA', { a: n(c.moduleTotalA) }))
    if (c.moduleTotalW !== undefined) parts.push(t('capabilities.moduleTotalW', { w: n(c.moduleTotalW) }))
    if (c.busCurrentUsedMa !== undefined) parts.push(t('capabilities.busUsed', { ma: n(c.busCurrentUsedMa) }))
    if (c.busCurrentSuppliedMa !== undefined) parts.push(t('capabilities.busSupplied', { ma: n(c.busCurrentSuppliedMa) }))
    if (c.busDevicesMax !== undefined) parts.push(t('capabilities.busDevicesMax', { count: c.busDevicesMax }))
    if (c.railWidthTe !== undefined) parts.push(t('capabilities.railWidth', { te: n(c.railWidthTe) }))
    if (c.enclosureRows !== undefined || c.enclosureTePerRow !== undefined) {
      parts.push(t('capabilities.enclosure', { rows: c.enclosureRows ?? '?', te: c.enclosureTePerRow ?? '?' }))
    }
    if (c.wirelessPlacesSupplied !== undefined) parts.push(t('capabilities.wirelessSupplied', { count: c.wirelessPlacesSupplied }))
    if (c.wirelessPlacesUsed !== undefined) parts.push(t('capabilities.wirelessUsed', { count: c.wirelessPlacesUsed }))
    if (c.zigbeeRouter !== undefined) parts.push(c.zigbeeRouter ? t('capabilities.router') : t('capabilities.noRouter'))
    if (c.motorType) parts.push(t(`capabilities.motor.${c.motorType}`))
    parts.push(t('capabilities.mounting', { mounting: t(`mounting.${c.mounting}`) }))
    return parts.join(' · ')
  }
}
