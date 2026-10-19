import { useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { fetchFile } from '@/api/client'
import {
  getExportHdlCommissioningQueryKey,
  getExportKnxDevicesQueryKey,
  getExportKnxGroupAddressesQueryKey,
  getExportWirelessDevicesQueryKey,
  useAssignGroupAddresses,
} from '@/api/generated/installation/installation'
import type { AddressedItemScheme, GroupAddressSummary } from '@/api/generated/model'
import { useGetAddresses } from '@/api/generated/networks/networks'
import { Button, ErrorMessage, Loading, Notice, Section } from '@/components/ui'
import { saveBlob } from '@/lib/download'

/** Content changes in the editors: fetched on every visit. */
const everyVisit = { staleTime: 0, refetchOnMount: 'always' } as const

/** The query key's first element is the endpoint's URL (orval). */
const urlOf = (key: readonly unknown[]) => String(key[0])

type ExportKey = 'knxGroupAddresses' | 'hdlCommissioning' | 'wirelessDevices' | 'knxDevices'

type Export = {
  key: ExportKey
  url: string
  scheme: Exclude<AddressedItemScheme, 'none'>
  missing: 'noKnx' | 'noHdl' | 'noWireless'
}

/**
 * The programming exports of a version (3e, D422, D423). Each export is
 * fetched as a file, so an API error (e.g. too many group addresses) shows
 * here instead of as a broken download. An export is disabled with the
 * reason when the version has no device of its addressing scheme (D419).
 * The KNX group addresses are stored once assigned; "Update group
 * addresses" assigns new needs without renumbering the others.
 */
export function ProgrammingExportsSection({ versionId }: { versionId: string }) {
  const { t } = useTranslation('installation')
  const addresses = useGetAddresses(versionId, { query: everyVisit })
  const assign = useAssignGroupAddresses()
  const [busy, setBusy] = useState<ExportKey | null>(null)
  const [failed, setFailed] = useState<{ key: ExportKey; error: unknown } | null>(null)
  const [assigned, setAssigned] = useState<GroupAddressSummary | null>(null)
  const exports: Export[] = [
    { key: 'knxGroupAddresses', url: urlOf(getExportKnxGroupAddressesQueryKey(versionId)), scheme: 'knx', missing: 'noKnx' },
    { key: 'knxDevices', url: urlOf(getExportKnxDevicesQueryKey(versionId)), scheme: 'knx', missing: 'noKnx' },
    { key: 'hdlCommissioning', url: urlOf(getExportHdlCommissioningQueryKey(versionId)), scheme: 'hdl', missing: 'noHdl' },
    { key: 'wirelessDevices', url: urlOf(getExportWirelessDevicesQueryKey(versionId)), scheme: 'ieee', missing: 'noWireless' },
  ]

  const download = async (e: Export) => {
    setBusy(e.key)
    setFailed(null)
    try {
      const file = await fetchFile(e.url)
      saveBlob(file.blob, file.fileName)
    } catch (error) {
      setFailed({ key: e.key, error })
    } finally {
      setBusy(null)
    }
  }

  const updateGroupAddresses = async () => {
    setAssigned(null)
    try {
      setAssigned(await assign.mutateAsync({ versionId }))
    } catch {
      // shown from assign.error
    }
  }

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
            const label = `${t('exports.download')}: ${t(`exports.${e.key}`)}`
            const canAssign = e.key === 'knxGroupAddresses' && available && addresses.data.can.update
            return (
              <li key={e.key} className="space-y-2 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-medium">{t(`exports.${e.key}`)}</p>
                    <p className="text-sm text-muted" id={reasonId}>
                      {available ? t(`exports.${e.key}Hint`) : t(`exports.${e.missing}`)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {canAssign && (
                      <Button variant="secondary" size="sm" onClick={() => void updateGroupAddresses()} disabled={assign.isPending}>
                        <RefreshCw aria-hidden /> {t('exports.updateGroupAddresses')}
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!available || busy === e.key}
                      aria-describedby={available ? undefined : reasonId}
                      aria-label={label}
                      onClick={() => void download(e)}
                    >
                      <Download aria-hidden /> {t('exports.download')}
                    </Button>
                  </div>
                </div>
                {e.key === 'knxGroupAddresses' && assigned && (
                  <Notice>{t('exports.groupAddressesUpdated', { added: assigned.added, total: assigned.total })}</Notice>
                )}
                {e.key === 'knxGroupAddresses' && assign.error && <ErrorMessage error={assign.error} />}
                {failed?.key === e.key && <ErrorMessage error={failed.error} />}
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}
