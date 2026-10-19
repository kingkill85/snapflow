import { Plug, TriangleAlert, Unplug } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ChannelInfo, Finding } from '@/api/generated/model'
import { useDeleteConnection } from '@/api/generated/wiring/wiring'
import { Badge, Button, ErrorMessage, IconButton } from '@/components/ui'
import { ConnectDialog, type ConnectTarget, itemKey, needKey, useFindingText, useRefreshWiring, type WiringModel } from '@/features/checks'
import { useFormatWatts } from '@/features/needs/format'

type Props = {
  versionId: string
  planId: string
  moduleId: string
  /** The module's variant has channels (else nothing is shown). */
  hasChannels: boolean
  wiring: WiringModel
  /** The version's checks findings; errors on a channel or its connections mark the channel. */
  findings?: Finding[]
}

/**
 * The channels of a board module in the inspector (step 3d): per output kind, native channels first, then the
 * alternatives (D387), each with its connected needs (need, zone, units, power), Disconnect and "Connect a need".
 * Connections are version data: no plan lock needed, only `can.update`.
 */
export function ModuleChannels({ versionId, planId, moduleId, hasChannels, wiring, findings = [] }: Props) {
  const { t } = useTranslation('plans')
  const { t: tChecks } = useTranslation('checks')
  const watts = useFormatWatts()
  const findingText = useFindingText()
  const refresh = useRefreshWiring(versionId)
  const remove = useDeleteConnection()
  const [target, setTarget] = useState<ConnectTarget | null>(null)
  const item = wiring.items.get(itemKey(planId, moduleId))
  if (!item) {
    if (!hasChannels) return null
    return <p className="text-sm text-muted">{wiring.query.isPending ? t('board.channelsLoading') : t('board.channelsAfterSave')}</p>
  }
  const groups: { kindId: string; channels: ChannelInfo[] }[] = []
  for (const c of item.channels) {
    const last = groups[groups.length - 1]
    if (last?.kindId === c.outputKindId) last.channels.push(c)
    else groups.push({ kindId: c.outputKindId, channels: [c] })
  }
  // Errors of a channel: findings about the channel itself or about one of its connections.
  const errorsOf = (c: ChannelInfo) =>
    findings.filter((f) => {
      if (f.severity !== 'error') return false
      const r = f.refs
      if (r.targetPlanId === planId && r.itemId === moduleId && r.outputKindId === c.outputKindId && r.channelNo === c.channelNo) return true
      return (r.connectionIds ?? []).some((id) => c.connectionIds.includes(id))
    })
  const disconnect = async (id: string) => {
    try {
      await remove.mutateAsync({ versionId, id })
      await refresh()
    } catch {
      // shown by ErrorMessage
    }
  }
  return (
    <section aria-label={t('board.channels')} className="space-y-3">
      <h3 className="text-sm font-medium">{t('board.channels')}</h3>
      <ErrorMessage error={remove.error} />
      {groups.map((g) => {
        const free = g.channels.filter((c) => c.connectionIds.length === 0 && !c.blocked).length
        return (
          <div key={g.kindId} className="space-y-1">
            <p className="text-xs font-medium text-muted">{t('board.channelsFree', { kind: wiring.kindName(g.kindId), free, total: g.channels.length })}</p>
            <ul className="divide-y divide-line rounded-control border border-line">
              {g.channels.map((c) => {
                const ref = { targetPlanId: planId, targetItemId: moduleId, outputKindId: c.outputKindId, channelNo: c.channelNo }
                const name = tChecks('channel.short', { kind: wiring.kindName(c.outputKindId), no: c.channelNo })
                const base = wiring.kindByKey.get(c.baseKindKey)
                const errors = errorsOf(c)
                return (
                  <li key={c.channelNo} data-testid={`channel-${c.outputKindId}-${c.channelNo}`} className="space-y-1 px-2 py-1.5 text-sm">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{name}</span>
                      {c.alternative && (
                        <span className="text-xs text-muted">
                          {tChecks('channel.alternative', { baseKind: base ? wiring.kindName(base.id) : c.baseKindKey, from: c.baseFrom, to: c.baseTo })}
                        </span>
                      )}
                      {errors.length > 0 && (
                        <Badge variant="danger">
                          <TriangleAlert aria-hidden />
                          {t('board.channelError', { count: errors.length })}
                        </Badge>
                      )}
                      {c.blocked && <Badge>{tChecks('channel.blocked')}</Badge>}
                      {!c.blocked && c.connectionIds.length === 0 && <Badge variant="success">{t('board.channelFree')}</Badge>}
                      <span className="flex-1" />
                      {wiring.canUpdate && !c.blocked && (
                        <Button size="sm" variant="ghost" aria-label={t('board.connectNeedTo', { channel: name })} title={t('board.connectNeed')} onClick={() => setTarget({ kind: 'channel', ...ref })}>
                          <Plug aria-hidden />
                          <span className="sr-only xl:not-sr-only">{t('board.connectNeed')}</span>
                        </Button>
                      )}
                    </div>
                    {errors.length > 0 && (
                      <ul className="space-y-0.5 text-xs text-danger" aria-label={t('board.channelErrors', { channel: name })}>
                        {errors.map((f, i) => (
                          <li key={i}>{findingText(f, wiring.findingNames(f))}</li>
                        ))}
                      </ul>
                    )}
                    {c.connectionIds.length > 0 && (
                      <ul className="space-y-1">
                        {c.connectionIds.map((id) => {
                          const conn = wiring.connections.get(id)
                          if (!conn) return null
                          const need = wiring.needs.get(needKey(conn.needPlanId, conn.needId))
                          const text = wiring.needText(need)
                          const power = need?.powerW != null ? t('board.connPower', { power: watts((Number(need.powerW) * conn.units).toFixed(2)) }) : null
                          return (
                            <li key={id} className="flex items-start gap-2 pl-2">
                              <div className="min-w-0 flex-1">
                                <p className="break-words">{text}</p>
                                <p className="text-xs text-muted">
                                  {[need ? wiring.needPlace(need) : '', t('board.connUnits', { count: conn.units }), power].filter(Boolean).join(' · ')}
                                </p>
                              </div>
                              {wiring.canUpdate && (
                                <IconButton
                                  variant="danger-quiet"
                                  icon={<Unplug />}
                                  label={tChecks('connection.disconnectFrom', { name: text })}
                                  disabled={remove.isPending}
                                  onClick={() => void disconnect(id)}
                                />
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
      <ConnectDialog versionId={versionId} wiring={wiring} target={target} onOpenChange={(open) => !open && setTarget(null)} />
    </section>
  )
}
