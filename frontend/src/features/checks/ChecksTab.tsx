import { Plug, Undo2, Wand2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useListPlans } from '@/api/generated/plans/plans'
import type { Checks, Finding, NeedInfo } from '@/api/generated/model'
import { useGetChecks, useUndoAutoConnect } from '@/api/generated/wiring/wiring'
import { Badge, Button, EmptyState, ErrorMessage, Loading, Notice, Section, TextLink } from '@/components/ui'
import { boardPath, editorPath } from '@/features/plans/paths'
import { versionPath } from '@/features/projects/paths'

import { AutoConnectDialog } from './AutoConnectDialog'
import { ConnectDialog, type ConnectTarget } from './ConnectDialog'
import { areaOf, areas, useFindingText } from './format'
import { StatusChip } from './StatusChip'
import { useRefreshWiring, useWiringModel } from './wiring'

/** Checks change with every edit elsewhere: fetched on every visit. */
const everyVisit = { staleTime: 0, refetchOnMount: 'always' } as const

const severities = ['error', 'warning', 'info'] as const
/**
 * The Checks tab of a version (step 3d): overview cards, the findings grouped by severity and area with links
 * to the editor that fixes them, the unconnected needs with Connect… and Auto-connect with preview and undo.
 * Everything shown is computed by the API (rule 1).
 */
export function ChecksTab({ projectId, versionId }: { projectId: string; versionId: string }) {
  const { t } = useTranslation('checks')
  const checks = useGetChecks(versionId, { query: everyVisit })
  const wiring = useWiringModel(versionId)
  const plans = useListPlans(versionId)
  const refresh = useRefreshWiring(versionId)
  const undo = useUndoAutoConnect()
  const [connect, setConnect] = useState<ConnectTarget | null>(null)
  const [autoOpen, setAutoOpen] = useState(false)
  const [applied, setApplied] = useState<{ batchId: string | null; count: number; undone?: number } | null>(null)

  if (checks.isError) return <ErrorMessage error={checks.error} />
  if (wiring.query.isError) return <ErrorMessage error={wiring.query.error} />
  if (checks.isPending || wiring.query.isPending) return <Loading />
  const data = checks.data
  const planKind = new Map<string, string>((plans.data ?? []).map((p) => [p.id, p.kind]))

  const undoBatch = async () => {
    if (!applied?.batchId) return
    try {
      const r = await undo.mutateAsync({ versionId, batchId: applied.batchId })
      await refresh()
      setApplied({ ...applied, undone: r.removed })
    } catch {
      // shown by ErrorMessage
    }
  }

  const unconnected = wiring.data.needs.filter((n) => n.connectedUnits < n.quantity)
  const missingZones = data.zones.filter((z) => z.status === 'partial' || z.status === 'missing')
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t('tab.title')}</h2>
          <p className="text-sm text-muted">{t('tab.description')}</p>
        </div>
        {wiring.canUpdate && (
          <Button onClick={() => setAutoOpen(true)} disabled={unconnected.length === 0}>
            <Wand2 aria-hidden />
            {t('auto.open')}
          </Button>
        )}
      </div>

      {applied && (
        <Notice>
          <span className="flex flex-wrap items-center gap-3">
            {applied.undone != null ? t('auto.undone', { count: applied.undone }) : t('auto.applied', { count: applied.count })}
            {applied.batchId && applied.undone == null && wiring.canUpdate && (
              <Button size="sm" variant="secondary" onClick={() => void undoBatch()} disabled={undo.isPending}>
                <Undo2 aria-hidden />
                {t('auto.undo')}
              </Button>
            )}
          </span>
        </Notice>
      )}
      <ErrorMessage error={undo.error} />

      <Overview checks={data} kindName={wiring.kindNameByKey} />

      <Section title={t('findings.title')} description={t('findings.count', { errors: data.counts.errors, warnings: data.counts.warnings, infos: data.counts.infos })}>
        <Findings checks={data} projectId={projectId} versionId={versionId} wiring={wiring} planKind={planKind} />
      </Section>

      <Section title={t('unconnected.title')} description={t('unconnected.description', { count: unconnected.length })}>
        <Unconnected needs={unconnected} wiring={wiring} projectId={projectId} versionId={versionId} onConnect={(n) => setConnect({ kind: 'need', needPlanId: n.planId, needId: n.needId })} />
      </Section>

      <ConnectDialog versionId={versionId} wiring={wiring} target={connect} onOpenChange={(open) => !open && setConnect(null)} />
      <AutoConnectDialog
        versionId={versionId}
        wiring={wiring}
        open={autoOpen}
        onOpenChange={setAutoOpen}
        zones={missingZones}
        onApplied={(batchId, count) => setApplied({ batchId, count })}
      />
    </div>
  )
}

/** One overview card: a title, a big value and lines below. */
function Card({ title, value, status, children }: { title: string; value?: ReactNode; status?: ReactNode; children?: ReactNode }) {
  return (
    <div className="space-y-2 rounded-control border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium text-muted">{title}</h3>
        {status}
      </div>
      {value != null && <p className="text-2xl font-semibold">{value}</p>}
      {children}
    </div>
  )
}

function Overview({ checks, kindName }: { checks: Checks; kindName: (key: string) => string }) {
  const { t } = useTranslation('checks')
  const c = checks.counts
  const zonesStatus = c.zonesWithNeeds === 0 ? 'unknown' : c.zonesCovered === c.zonesWithNeeds ? 'ok' : 'red'
  const open = c.units - c.connectedUnits
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <Card
        title={t('overview.zones')}
        value={t('overview.zonesValue', { covered: c.zonesCovered, total: c.zonesWithNeeds })}
        status={<Badge variant={zonesStatus === 'ok' ? 'success' : zonesStatus === 'red' ? 'danger' : 'neutral'}>{t(zonesStatus === 'ok' ? 'overview.allCovered' : zonesStatus === 'red' ? 'overview.notAllCovered' : 'overview.noNeeds')}</Badge>}
      />
      <Card
        title={t('overview.unconnected')}
        value={open}
        status={<Badge variant={open === 0 ? 'success' : 'warning'}>{t('overview.unitsOf', { connected: c.connectedUnits, total: c.units })}</Badge>}
      />
      <Card
        title={t('overview.findings')}
        value={t('overview.findingsValue', { errors: c.errors, warnings: c.warnings })}
        status={<Badge variant={c.errors > 0 ? 'danger' : c.warnings > 0 ? 'warning' : 'success'}>{t(c.errors > 0 ? 'status.red' : c.warnings > 0 ? 'status.amber' : 'status.ok')}</Badge>}
      />
      {checks.boards.map((b) => (
        <Card key={b.planId} title={t('overview.board', { name: b.name })} status={<StatusChip status={b.status} />}>
          <p className="text-sm">{t('overview.te', { used: b.usedTe, capacity: b.capacityTe })}</p>
          <ul className="space-y-0.5 text-sm text-muted">
            {b.channels.map((ch) => (
              <li key={`${ch.outputKindId}/${ch.alternative}`}>
                {t(ch.alternative ? 'overview.channelsAlternative' : 'overview.channels', { kind: kindName(ch.outputKindKey), free: ch.free, total: ch.total })}
              </li>
            ))}
          </ul>
        </Card>
      ))}
      {checks.busLines.map((l) => (
        <Card key={l.busLineId} title={t('overview.busLine', { name: l.name })} status={<StatusChip status={worst(l.currentStatus, l.devicesStatus)} />}>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {t('overview.current', { used: l.currentUsedMa, supplied: l.currentSuppliedMa, reserve: l.reservePercent })}
            <StatusChip status={l.currentStatus} />
          </p>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {l.devicesMax != null ? t('overview.devicesOf', { devices: l.devices, max: l.devicesMax }) : t('overview.devices', { count: l.devices })}
            <StatusChip status={l.devicesStatus} />
          </p>
          {l.unknownCurrentCount > 0 && <p className="text-sm text-muted">{t('overview.unknownCurrent', { count: l.unknownCurrentCount })}</p>}
        </Card>
      ))}
      {checks.gateways.map((g) => (
        <Card key={`${g.planId}/${g.itemId}`} title={t('overview.gateway', { name: g.label })} status={<StatusChip status={g.status} />}>
          <p className="text-sm">{t('overview.places', { used: g.placesUsed, supplied: g.placesSupplied, reserve: g.reservePercent })}</p>
          <p className="text-sm text-muted">{t('overview.gatewayDevices', { count: g.devices, routers: g.routers })}</p>
        </Card>
      ))}
    </div>
  )
}

const rank: Record<string, number> = { red: 3, amber: 2, unknown: 1, ok: 0 }
const worst = (a: string, b: string) => ((rank[a] ?? 0) >= (rank[b] ?? 0) ? a : b)

function Findings({
  checks,
  projectId,
  versionId,
  wiring,
  planKind,
}: {
  checks: Checks
  projectId: string
  versionId: string
  wiring: ReturnType<typeof useWiringModel>
  planKind: Map<string, string>
}) {
  const { t } = useTranslation('checks')
  const text = useFindingText()
  if (checks.findings.length === 0) return <EmptyState title={t('findings.none')} />
  const linkOf = (f: Finding): string | null => {
    const r = f.refs
    if (r.busLineId) return `${versionPath(projectId, versionId)}?tab=networks#line-${r.busLineId}`
    if (r.targetPlanId && r.itemId) {
      if (planKind.get(r.targetPlanId) === 'board') return `${boardPath(projectId, versionId, r.targetPlanId)}?select=${r.itemId}`
      if (f.code.startsWith('gateway_') || f.code.startsWith('wireless_') || f.code.startsWith('bus_'))
        return `${editorPath(projectId, versionId, r.targetPlanId)}?select=${r.itemId}`
    }
    if (r.planId && (r.needId || r.zoneId)) return `${editorPath(projectId, versionId, r.planId)}?select=${r.zoneId ?? r.needId}`
    if (r.targetPlanId && r.itemId) return `${editorPath(projectId, versionId, r.targetPlanId)}?select=${r.itemId}`
    if (r.targetPlanId) return planKind.get(r.targetPlanId) === 'board' ? boardPath(projectId, versionId, r.targetPlanId) : editorPath(projectId, versionId, r.targetPlanId)
    return null
  }
  return (
    <div className="space-y-5">
      {severities.map((sev) => {
        const list = checks.findings.filter((f) => f.severity === sev)
        if (list.length === 0) return null
        return (
          <div key={sev} className="space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Badge variant={sev === 'error' ? 'danger' : sev === 'warning' ? 'warning' : 'neutral'}>{list.length}</Badge>
              {t(`severity.${sev}`)}
            </h3>
            {areas.map((area) => {
              const inArea = list.filter((f) => areaOf(f.code) === area)
              if (inArea.length === 0) return null
              return (
                <div key={area} className="space-y-1 pl-2">
                  <h4 className="text-xs font-medium text-muted">{t(`area.${area}`)}</h4>
                  <ul className="space-y-1 text-sm">
                    {inArea.map((f, i) => {
                      const link = linkOf(f)
                      const words = text(f, wiring.findingNames(f))
                      return (
                        <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-3">
                          <span>{words}</span>
                          {link && (
                            <TextLink to={link} aria-label={t('findings.openFor', { text: words })}>
                              {t('findings.open')}
                            </TextLink>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function Unconnected({
  needs,
  wiring,
  projectId,
  versionId,
  onConnect,
}: {
  needs: NeedInfo[]
  wiring: ReturnType<typeof useWiringModel>
  projectId: string
  versionId: string
  onConnect: (need: NeedInfo) => void
}) {
  const { t } = useTranslation('checks')
  if (needs.length === 0) return <EmptyState title={t('unconnected.none')} />
  // Grouped by plan → zone, in the API's order.
  const groups: { key: string; planId: string; plan: string; zone: string; zoneId: string | null; needs: NeedInfo[] }[] = []
  for (const n of needs) {
    const key = `${n.planId}/${n.zoneId ?? ''}`
    const last = groups.at(-1)
    if (last?.key === key) last.needs.push(n)
    else groups.push({ key, planId: n.planId, plan: n.planName, zone: n.zoneName || t('need.noZone'), zoneId: n.zoneId, needs: [n] })
  }
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <div key={g.key} className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-line pb-1">
            <h3 className="text-sm font-semibold">
              {g.plan} · {g.zone}
            </h3>
            <TextLink to={`${editorPath(projectId, versionId, g.planId)}${g.zoneId ? `?select=${g.zoneId}` : ''}`}>{t('unconnected.openPlan')}</TextLink>
          </div>
          <ul className="space-y-1" aria-label={`${g.plan} · ${g.zone}`}>
            {g.needs.map((n) => {
              const name = wiring.needText(n)
              return (
                <li key={n.needId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
                  <span>
                    {name} <span className="text-muted">— {t('unconnected.connected', { connected: n.connectedUnits, quantity: n.quantity })}</span>
                  </span>
                  {wiring.canUpdate && (
                    <Button size="sm" variant="secondary" aria-label={t('connection.connectNeed', { name })} onClick={() => onConnect(n)}>
                      <Plug aria-hidden />
                      {t('connection.connect')}
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}
