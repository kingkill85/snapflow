import { useTranslation } from 'react-i18next'

import { useGetAddresses, useListBusLines } from '@/api/generated/networks/networks'

/** Version data that changes in other tabs: fetched on every visit. */
const everyVisit = { staleTime: 0, refetchOnMount: 'always' } as const

/**
 * The read-only address of a bus or wireless device in the inspectors (3e, D427):
 * "KNX 1.1.5 · Line KNX 1", "HDL 1.12", "IEEE 00124B001CA1B2C3" or "No address yet".
 * Nothing for devices without an address scheme and for power supplies; edited on the Networks tab.
 */
export function AddressLine({ versionId, planId, itemId }: { versionId: string; planId: string; itemId: string }) {
  const { t } = useTranslation('plans')
  const addresses = useGetAddresses(versionId, { query: everyVisit })
  const lines = useListBusLines(versionId, { query: everyVisit })
  const item = addresses.data?.items.find((i) => i.planId === planId && i.itemId === itemId)
  if (!item || item.scheme === 'none' || item.powerSupply) return null
  const a = item.address
  const value = item.scheme === 'knx' ? a?.knx : item.scheme === 'hdl' ? a?.hdl : a?.ieee
  const line = item.busLineId ? lines.data?.find((l) => l.id === item.busLineId)?.name : undefined
  const scheme = t(`address.scheme.${item.scheme}`)
  return (
    <div className="space-y-0.5" data-testid="address-line">
      <p className="text-xs font-medium text-muted">{t('address.label')}</p>
      {value ? (
        <p className="text-sm tabular-nums">
          {[`${scheme} ${value}`, line && t('address.line', { name: line })].filter(Boolean).join(' · ')}
          {a?.pinned === false && <span className="text-muted"> ({t('address.automatic')})</span>}
        </p>
      ) : (
        <p className="text-sm text-muted">{line ? t('address.noneOnLine', { name: line }) : t('address.none')}</p>
      )}
    </div>
  )
}
