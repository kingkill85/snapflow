import { useTranslation } from 'react-i18next'

import { useListLoadTypes } from '@/api/generated/load-types/load-types'
import type { Capabilities, Limit } from '@/api/generated/model'
import { useListOutputKinds } from '@/api/generated/output-kinds/output-kinds'
import { formatDecimal, useDecimalSeparator } from '@/catalog/decimal'
import { useLocalized } from '@/i18n/localized'

/** Capabilities as one line of plain words ("6 × Dimmer output · max 200 W LED · … · mounting: board"). Every number is shown with formatDecimal (D144). */
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
  const loadName = (id?: string, key?: string) => {
    const load = loads.find((l) => l.id === id)
    return load ? localized(load.name) : (key ?? '')
  }
  const n = (v: number) => formatDecimal(v, separator)
  // "200 W LED, 220 W halogen" (a limit without load type: "200 W").
  const limits = (list: Limit[], unit: 'W' | 'A') =>
    list
      .map((l) => {
        const value = t(unit === 'W' ? 'capabilities.valueW' : 'capabilities.valueA', { v: n(l.value) })
        return l.loadTypeId || l.loadTypeKey ? t('capabilities.withLoad', { value, load: loadName(l.loadTypeId, l.loadTypeKey) }) : value
      })
      .join(', ')
  const systemDefault = (text: string, isDefault: boolean) => (isDefault ? t('capabilities.systemDefault', { text }) : text)

  return (c: Capabilities) => {
    const parts: string[] = []
    for (const ch of c.channels) {
      const channel = [t('capabilities.channels', { n: n(ch.count), kind: kindName(ch.outputKindId, ch.outputKindKey) })]
      if (ch.limitsW.length > 0) channel.push(t('capabilities.max', { limits: limits(ch.limitsW, 'W') }))
      if (ch.limitsA.length > 0) channel.push(t('capabilities.limitsA', { limits: limits(ch.limitsA, 'A') }))
      if (ch.minLoadsW.length > 0) channel.push(t('capabilities.minLoads', { limits: limits(ch.minLoadsW, 'W') }))
      for (const alt of ch.alternatives) {
        channel.push(t('capabilities.alternative', { max: n(alt.max), per: n(alt.per), kind: kindName(alt.outputKindId, alt.outputKindKey) }))
      }
      parts.push(channel.join(', '))
    }
    if (c.moduleTotalA !== undefined) parts.push(t('capabilities.moduleTotalA', { a: n(c.moduleTotalA) }))
    if (c.moduleTotalsW.length > 0) parts.push(t('capabilities.moduleTotalsW', { limits: limits(c.moduleTotalsW, 'W') }))
    if (c.busCurrentUsedMa !== undefined) parts.push(systemDefault(t('capabilities.busUsed', { ma: n(c.busCurrentUsedMa) }), c.busCurrentUsedMaDefault))
    if (c.busCurrentSuppliedMa !== undefined) parts.push(t('capabilities.busSupplied', { ma: n(c.busCurrentSuppliedMa) }))
    if (c.busDevicesMax !== undefined) parts.push(t('capabilities.busDevicesMax', { count: c.busDevicesMax, n: n(c.busDevicesMax) }))
    if (c.railWidthTe !== undefined) parts.push(t('capabilities.railWidth', { te: n(c.railWidthTe) }))
    if (c.enclosureRows !== undefined || c.enclosureTePerRow !== undefined) {
      parts.push(
        t('capabilities.enclosure', {
          rows: c.enclosureRows === undefined ? '?' : n(c.enclosureRows),
          te: c.enclosureTePerRow === undefined ? '?' : n(c.enclosureTePerRow),
        }),
      )
    }
    if (c.wirelessPlacesSupplied !== undefined) {
      parts.push(t('capabilities.wirelessSupplied', { count: c.wirelessPlacesSupplied, n: n(c.wirelessPlacesSupplied) }))
    }
    if (c.wirelessPlacesUsed !== undefined) {
      parts.push(systemDefault(t('capabilities.wirelessUsed', { count: c.wirelessPlacesUsed, n: n(c.wirelessPlacesUsed) }), c.wirelessPlacesUsedDefault))
    }
    if (c.zigbeeRouter !== undefined) parts.push(c.zigbeeRouter ? t('capabilities.router') : t('capabilities.noRouter'))
    if (c.motorType) parts.push(t(`capabilities.motor.${c.motorType}`))
    parts.push(t('capabilities.mounting', { mounting: t(`mounting.${c.mounting}`) }))
    return parts.join(' · ')
  }
}
