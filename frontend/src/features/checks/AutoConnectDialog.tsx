import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError } from '@/api/client'
import type { AutoConnectPreview, AutoConnectScope, ZoneStatus } from '@/api/generated/model'
import { useApplyAutoConnect, usePreviewAutoConnect } from '@/api/generated/wiring/wiring'
import { Button, CheckboxGroupField, Dialog, ErrorMessage, Notice, SelectField } from '@/components/ui'

import { useReasonText } from './format'
import { needKey, useRefreshWiring, type WiringModel } from './wiring'

type Props = {
  versionId: string
  wiring: WiringModel
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Zones that can be chosen for scope "selected zones" (those with unconnected units). */
  zones: ZoneStatus[]
  /** After apply: the batch to undo (null when nothing was connected) and how many connections were made. */
  onApplied: (batchId: string | null, count: number) => void
}

type Step = { scope: AutoConnectScope; preview: AutoConnectPreview }

/**
 * Auto-connect (D391): choose the scope, preview what would be connected and what cannot (per need with the
 * reason), apply as one batch. A change since the preview (409 auto_connect.changed) previews again.
 */
export function AutoConnectDialog({ versionId, wiring, open, onOpenChange, zones, onApplied }: Props) {
  const { t } = useTranslation('checks')
  const { t: tCommon } = useTranslation()
  const reasonText = useReasonText()
  const refresh = useRefreshWiring(versionId)
  const preview = usePreviewAutoConnect()
  const apply = useApplyAutoConnect()
  const [scope, setScope] = useState<'all' | 'zones'>('all')
  const [zoneIds, setZoneIds] = useState<string[]>([])
  const [step, setStep] = useState<Step | null>(null)
  const [changed, setChanged] = useState(false)

  const reset = () => {
    setStep(null)
    setChanged(false)
    preview.reset()
    apply.reset()
  }
  const close = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }
  const runPreview = async (s: AutoConnectScope) => {
    try {
      const p = await preview.mutateAsync({ versionId, data: s })
      setStep({ scope: s, preview: p })
    } catch {
      // shown by ErrorMessage
    }
  }
  const currentScope = (): AutoConnectScope => (scope === 'all' ? { scope: 'all' } : { scope: 'zones', zoneIds })
  const runApply = async () => {
    if (!step) return
    try {
      const result = await apply.mutateAsync({ versionId, data: { ...step.scope, expectedChecksum: step.preview.checksum } })
      await refresh()
      onApplied(result.batchId, result.connections.length)
      close(false)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === 'auto_connect.changed') {
        apply.reset()
        setChanged(true)
        await runPreview(step.scope)
      }
    }
  }

  const p = step?.preview
  const zoneOptions = zones.filter((z) => z.zoneId).map((z) => ({ value: z.zoneId!, label: `${z.name} (${t('zoneStatus.partial', { connected: z.connectedUnits, units: z.units })})` }))
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={t('auto.title')}
      description={t('auto.description')}
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)}>
            {tCommon('action.cancel')}
          </Button>
          {step ? (
            <Button onClick={() => void runApply()} disabled={apply.isPending || preview.isPending || !wiring.canUpdate || p!.connections.length === 0}>
              {t('auto.apply')}
            </Button>
          ) : (
            <Button onClick={() => void runPreview(currentScope())} disabled={preview.isPending || (scope === 'zones' && zoneIds.length === 0)}>
              {t('auto.preview')}
            </Button>
          )}
        </>
      }
    >
      <div className="min-h-0 space-y-4 overflow-y-auto">
        <ErrorMessage error={apply.error ?? preview.error} />
        {!step ? (
          <>
            <SelectField
              label={t('auto.scope')}
              value={scope}
              onValueChange={(v) => setScope(v as 'all' | 'zones')}
              options={[
                { value: 'all', label: t('auto.scopeAll') },
                { value: 'zones', label: t('auto.scopeZones') },
              ]}
            />
            {scope === 'zones' && <CheckboxGroupField label={t('auto.zones')} options={zoneOptions} value={zoneIds} onChange={setZoneIds} />}
          </>
        ) : (
          <>
            {changed && <Notice tone="warning">{t('auto.changed')}</Notice>}
            <p className="text-sm font-medium" role="status">
              {p!.unconnectable.length > 0
                ? t('auto.summaryWithFailures', { count: p!.connectedUnits, failed: p!.units - p!.connectedUnits })
                : p!.units === 0
                  ? t('auto.nothing')
                  : t('auto.summary', { count: p!.connectedUnits })}
            </p>
            {p!.unconnectable.length > 0 && (
              <ul className="space-y-1 text-sm" aria-label={t('auto.failures')}>
                {p!.unconnectable.map((u) => {
                  const need = wiring.needs.get(needKey(u.needPlanId, u.needId))
                  const ft = need ? wiring.functionTypeName(need.functionTypeId) : undefined
                  return (
                    <li key={`${u.needPlanId}/${u.needId}`} className="rounded-control border border-line px-3 py-2">
                      <p>
                        {wiring.needText(need)} — {need ? wiring.needPlace(need) : ''}
                      </p>
                      <p className="text-xs text-muted">
                        {t('auto.unitsLeft', { count: u.units })}: {reasonText(u.reason, ft)}
                      </p>
                    </li>
                  )
                })}
              </ul>
            )}
            <Button variant="secondary" size="sm" onClick={reset}>
              {t('auto.back')}
            </Button>
          </>
        )}
      </div>
    </Dialog>
  )
}
