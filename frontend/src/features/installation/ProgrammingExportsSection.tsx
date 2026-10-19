import { Download } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  getExportHdlCommissioningQueryKey,
  getExportKnxDevicesQueryKey,
  getExportKnxGroupAddressesQueryKey,
  getExportZigbeeDevicesQueryKey,
} from '@/api/generated/installation/installation'
import type { AddressedItemScheme } from '@/api/generated/model'
import { useGetAddresses } from '@/api/generated/networks/networks'
import { Button, ErrorMessage, Loading, Section } from '@/components/ui'

/** Content changes in the editors: fetched on every visit. */
const everyVisit = { staleTime: 0, refetchOnMount: 'always' } as const

/** The query key's first element is the endpoint's URL (orval). */
const urlOf = (key: readonly unknown[]) => String(key[0])

type Export = {
  key: 'knxGroupAddresses' | 'hdlCommissioning' | 'zigbeeDevices' | 'knxDevices'
  url: string
  scheme: Exclude<AddressedItemScheme, 'none'>
  missing: 'noKnx' | 'noHdl' | 'noWireless'
}

/**
 * The programming exports of a version (3e, D422, D423): download links the
 * API computes from the current state. An export is disabled with the reason
 * when the version has no device of its system (the scheme of the addressed
 * items, D419).
 */
export function ProgrammingExportsSection({ versionId }: { versionId: string }) {
  const { t } = useTranslation('installation')
  const addresses = useGetAddresses(versionId, { query: everyVisit })
  const exports: Export[] = [
    { key: 'knxGroupAddresses', url: urlOf(getExportKnxGroupAddressesQueryKey(versionId)), scheme: 'knx', missing: 'noKnx' },
    { key: 'knxDevices', url: urlOf(getExportKnxDevicesQueryKey(versionId)), scheme: 'knx', missing: 'noKnx' },
    { key: 'hdlCommissioning', url: urlOf(getExportHdlCommissioningQueryKey(versionId)), scheme: 'hdl', missing: 'noHdl' },
    { key: 'zigbeeDevices', url: urlOf(getExportZigbeeDevicesQueryKey(versionId)), scheme: 'ieee', missing: 'noWireless' },
  ]
  return (
    <Section title={t('exports.title')} description={t('exports.description')}>
      {addresses.isPending ? (
        <Loading />
      ) : addresses.isError ? (
        <ErrorMessage error={addresses.error} />
      ) : (
        <ul className="divide-y divide-line">
          {exports.map((e) => {
            const available = addresses.data.items.some((i) => i.scheme === e.scheme)
            const reasonId = `export-${e.key}-reason`
            return (
              <li key={e.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 space-y-0.5">
                  <p className="font-medium">{t(`exports.${e.key}`)}</p>
                  <p className="text-sm text-muted" id={reasonId}>
                    {available ? t(`exports.${e.key}Hint`) : t(`exports.${e.missing}`)}
                  </p>
                </div>
                {available ? (
                  <Button asChild variant="secondary" size="sm">
                    <a href={e.url} download aria-label={`${t('exports.download')}: ${t(`exports.${e.key}`)}`}>
                      <Download aria-hidden /> {t('exports.download')}
                    </a>
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" disabled aria-describedby={reasonId} aria-label={`${t('exports.download')}: ${t(`exports.${e.key}`)}`}>
                    <Download aria-hidden /> {t('exports.download')}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}
