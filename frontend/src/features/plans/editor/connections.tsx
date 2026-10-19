import { Plug, Unplug } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ZoneStatus } from '@/api/generated/model'
import { useDeleteConnection, useGetChecks } from '@/api/generated/wiring/wiring'
import { Badge, Button, ErrorMessage, IconButton, Notice } from '@/components/ui'
import { ConnectDialog, type ConnectTarget, statusTone, useFindingText, useRefreshWiring, useWiringModel } from '@/features/checks'

import { PlanWiringContext as Context, type PlanWiring, usePlanWiring } from './plan-wiring'

/**
 * Connections in the floorplan editor (3d): version data, so they work without the plan lock. The editor
 * provides the wiring model, the zone statuses of the checks and one connect picker; the zone inspector's
 * need rows and the symbol inspector show a need's connections through `NeedConnections`.
 */
export function PlanWiringProvider({ versionId, planId, children }: { versionId: string; planId: string; children: (value: PlanWiring) => ReactNode }) {
  const wiring = useWiringModel(versionId)
  const checks = useGetChecks(versionId)
  const refresh = useRefreshWiring(versionId)
  const findingText = useFindingText()
  const [target, setTarget] = useState<ConnectTarget | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const zoneStatus = useMemo(() => {
    const map = new Map<string, ZoneStatus>()
    for (const z of checks.data?.zones ?? []) if (z.planId === planId && z.zoneId) map.set(z.zoneId, z)
    return map
  }, [checks.data, planId])
  const value: PlanWiring = {
    versionId,
    planId,
    wiring,
    zoneStatus,
    refresh,
    connect: (needId) => {
      setWarnings([])
      setTarget({ kind: 'need', needPlanId: planId, needId })
    },
  }
  return (
    <Context.Provider value={value}>
      {children(value)}
      <ConnectDialog
        versionId={versionId}
        wiring={wiring}
        target={target}
        onOpenChange={(open) => !open && setTarget(null)}
        onConnected={(list) => setWarnings(list.map((w) => findingText(w, wiring.findingNames(w))))}
      />
      {warnings.length > 0 && (
        <div className="fixed right-4 bottom-4 z-30 max-w-sm">
          <Notice tone="warning">
            {warnings.map((w) => (
              <span key={w} className="block">
                {w}
              </span>
            ))}
          </Notice>
        </div>
      )}
    </Context.Provider>
  )
}

/** A zone's coverage as a badge ("Covered", "2/5", "Not connected"), colour and text (D393). */
export function ZoneStatusBadge({ status }: { status: ZoneStatus | undefined }) {
  const { t } = useTranslation('checks')
  if (!status || status.status === 'none') return null
  return (
    <Badge variant={statusTone(status.status)}>
      {status.status === 'partial' ? t('zoneStatus.partial', { connected: status.connectedUnits, units: status.units }) : t(`zoneStatus.${status.status}`)}
    </Badge>
  )
}

/** A need's connections ("2 × → Dimmer D1 · Dimmer output 3 (Main board)") with Disconnect and "Connect…". */
export function NeedConnections({ needId, name }: { needId: string; name: string }) {
  const ctx = usePlanWiring()
  const { t } = useTranslation('plans')
  const { t: tc } = useTranslation('checks')
  const remove = useDeleteConnection()
  if (!ctx || ctx.wiring.query.isPending) return null
  const { wiring, planId } = ctx
  const need = wiring.needs.get(`${planId}/${needId}`)
  if (!need) return <p className="text-xs text-muted">{t('connections.unsaved')}</p>
  const conns = wiring.connectionsOfNeed(planId, needId)
  const disconnect = async (id: string) => {
    try {
      await remove.mutateAsync({ versionId: ctx.versionId, id })
      await ctx.refresh()
    } catch {
      // shown by ErrorMessage
    }
  }
  const missing = need.quantity - need.connectedUnits
  return (
    <div className="space-y-1" aria-label={t('connections.label', { name })} role="group">
      <ErrorMessage error={remove.error} />
      {conns.length === 0 ? (
        <p className="text-xs text-muted">{tc('connection.none')}</p>
      ) : (
        <ul className="space-y-1">
          {conns.map((c) => {
            const line = tc('connection.line', { units: c.units, channel: wiring.channelText(c) })
            return (
              <li key={c.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 break-words">{line}</span>
                {wiring.canUpdate && (
                  <IconButton
                    variant="danger-quiet"
                    icon={<Unplug />}
                    label={tc('connection.disconnectFrom', { name: line })}
                    disabled={remove.isPending}
                    onClick={() => void disconnect(c.id)}
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}
      {wiring.canUpdate && missing > 0 && (
        <Button size="sm" variant="secondary" aria-label={tc('connection.connectNeed', { name })} onClick={() => ctx.connect(needId)}>
          <Plug /> {tc('connection.connect')}
        </Button>
      )}
    </div>
  )
}
