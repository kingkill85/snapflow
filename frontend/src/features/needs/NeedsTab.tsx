import { LayoutTemplate, PencilRuler, Plug } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import type { Room, RoomCounts, RoomFunctionTotal, RoomPlan, ZoneStatus } from '@/api/generated/model'
import { useGetRooms } from '@/api/generated/wiring/wiring'
import { Badge, Button, EmptyState, ErrorMessage, Loading, Notice, Section } from '@/components/ui'
import { AutoConnectDialog, statusTone, useWiringModel } from '@/features/checks'
import { editorPath } from '@/features/plans/paths'
import { useLocalized } from '@/i18n/localized'

import { hasPower, useFormatWatts, useNeedText } from './format'

/** A function type deleted from the catalog comes without a name: shown as "Unknown function". */
const named = (name: Record<string, string>) => (Object.keys(name).length > 0 ? name : undefined)

/** Needs and connections change in the editors and on the Checks tab: fetched on every visit. */
const everyVisit = { staleTime: 0, refetchOnMount: 'always' } as const

/** What the auto-connect dialog was opened for: one zone, or the whole version (needs outside every zone). */
type AutoTarget = { zone: ZoneStatus | null }

/**
 * The Needs tab as a room overview (4b-4, D455): every zone of every floorplan with its needs as chips, the units
 * connected out of needed and a status, plus the needs outside every zone; totals at the top. All counts come from
 * the API (`GET /rooms`, rule 1).
 */
export function NeedsTab({ projectId, versionId }: { projectId: string; versionId: string }) {
  const { t } = useTranslation('needs')
  const query = useGetRooms(versionId, { query: everyVisit })
  const [auto, setAuto] = useState<AutoTarget | null>(null)
  const [applied, setApplied] = useState<number | null>(null)

  if (query.isError) return <ErrorMessage error={query.error} />
  if (query.isPending) return <Loading />
  const rooms = query.data

  if (rooms.plans.length === 0) return <EmptyState title={t('rooms.empty')} />

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t('rooms.title')}</h2>
        <p className="text-sm text-muted">{t('rooms.description')}</p>
      </div>

      <Totals totals={rooms.totals} functionTypes={rooms.functionTypes} />

      {applied != null && (
        <Notice tone="success">{t('rooms.applied', { count: applied })}</Notice>
      )}

      {rooms.plans.map((plan) => (
        <PlanRooms
          key={plan.planId}
          plan={plan}
          projectId={projectId}
          versionId={versionId}
          canUpdate={rooms.can.update}
          onAutoConnect={(room) =>
            setAuto({
              zone: room.zoneId
                ? { planId: room.planId, zoneId: room.zoneId, name: room.name, units: room.units, connectedUnits: room.connectedUnits, status: room.status }
                : null,
            })
          }
        />
      ))}

      {auto && <RoomAutoConnect versionId={versionId} zone={auto.zone} onClose={() => setAuto(null)} onApplied={setApplied} />}
    </div>
  )
}

/** The existing auto-connect dialog for one zone (or the whole version); the wiring model loads only while it is open. */
function RoomAutoConnect({ versionId, zone, onClose, onApplied }: { versionId: string; zone: ZoneStatus | null; onClose: () => void; onApplied: (count: number) => void }) {
  const wiring = useWiringModel(versionId)
  return (
    <AutoConnectDialog
      versionId={versionId}
      wiring={wiring}
      open
      onOpenChange={(open) => !open && onClose()}
      zones={zone ? [zone] : []}
      initialZoneIds={zone?.zoneId ? [zone.zoneId] : undefined}
      onApplied={(_batch, count) => onApplied(count)}
    />
  )
}

/** The version's totals: needs, units, connected, and per function. */
function Totals({ totals, functionTypes }: { totals: RoomCounts; functionTypes: RoomFunctionTotal[] }) {
  const { t } = useTranslation('needs')
  const localize = useLocalized()
  const watts = useFormatWatts()
  const tile = (label: string, value: string, sub?: string) => (
    <div className="rounded-control border border-line bg-surface p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
      {sub && <dd className="text-xs text-muted tabular-nums">{sub}</dd>}
    </div>
  )
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label={t('rooms.totals')}>
        {tile(t('rooms.totalNeeds'), String(totals.needs))}
        {tile(t('rooms.totalUnits'), String(totals.units))}
        {tile(t('rooms.totalConnected'), t('rooms.of', { connected: totals.connectedUnits, units: totals.units }))}
        {tile(t('rooms.totalPower'), hasPower(totals.powerW) ? t('line.power', { power: watts(totals.powerW) }) : '–')}
      </dl>
      {functionTypes.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={t('rooms.byFunction')}>
          {functionTypes.map((f) => (
            <li key={f.functionType.id}>
              <Badge wrap>
                {named(f.functionType.name) ? localize(f.functionType.name) : t('line.unknown')}: {t('rooms.connected', { connected: f.counts.connectedUnits, units: f.counts.units })}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PlanRooms({
  plan,
  projectId,
  versionId,
  canUpdate,
  onAutoConnect,
}: {
  plan: RoomPlan
  projectId: string
  versionId: string
  canUpdate: boolean
  onAutoConnect: (room: Room) => void
}) {
  const { t } = useTranslation('needs')
  const path = editorPath(projectId, versionId, plan.planId)
  return (
    <Section title={plan.name}>
      {plan.rooms.length === 0 ? (
        <EmptyState
          compact
          title={t('rooms.noZones')}
          action={
            <Button asChild variant="secondary" size="sm">
              <Link to={path}>
                <PencilRuler aria-hidden />
                {t('rooms.openEditor')}
              </Link>
            </Button>
          }
        />
      ) : (
        <ul className="space-y-3" aria-label={plan.name}>
          {plan.rooms.map((room) => (
            <RoomRow key={room.zoneId ?? 'outside'} room={room} path={path} canUpdate={canUpdate} onAutoConnect={() => onAutoConnect(room)} />
          ))}
        </ul>
      )}
    </Section>
  )
}

/** One zone (or the needs outside every zone): name, status, chips, actions. */
function RoomRow({ room, path, canUpdate, onAutoConnect }: { room: Room; path: string; canUpdate: boolean; onAutoConnect: () => void }) {
  const { t } = useTranslation('needs')
  const needText = useNeedText()
  const name = room.zoneId ? room.name : t('rooms.outside')
  const select = room.zoneId ? `?select=${room.zoneId}` : ''
  const open = room.status !== 'covered' && room.status !== 'none'
  return (
    <li aria-label={name} className="space-y-2 rounded-control border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h3 className="flex flex-wrap items-center gap-2 font-medium">
          <span className="break-words">{name}</span>
          {room.shortName && <Badge title={t('rooms.shortName')}>{room.shortName}</Badge>}
        </h3>
        <span className="flex flex-wrap items-center gap-2 text-sm">
          {room.units > 0 && <span className="text-muted tabular-nums">{t('rooms.connected', { connected: room.connectedUnits, units: room.units })}</span>}
          {room.status !== 'none' && <Badge variant={statusTone(room.status)}>{t(`rooms.status.${room.status}`)}</Badge>}
        </span>
      </div>

      {room.needs.length > 0 ? (
        <ul className="flex min-w-0 flex-wrap gap-2" aria-label={t('rooms.needsOf', { name })}>
          {room.needs.map((n) => (
            <li key={n.id} className="min-w-0 max-w-full">
              <Badge wrap variant={n.connectedUnits >= n.quantity ? 'neutral' : 'warning'}>
                {needText({ quantity: n.quantity, functionTypeName: named(n.functionType.name), powerW: n.powerW, label: n.label })}
                {n.connectedUnits < n.quantity && <span className="sr-only">{t('rooms.connected', { connected: n.connectedUnits, units: n.quantity })}</span>}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{t('rooms.noNeeds')}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button asChild variant="secondary" size="sm">
          <Link to={`${path}${select}`} aria-label={t('rooms.openEditorFor', { name })}>
            <PencilRuler aria-hidden />
            {t('rooms.openEditor')}
          </Link>
        </Button>
        {room.zoneId && canUpdate && (
          <Button asChild variant="secondary" size="sm">
            <Link to={`${path}?select=${room.zoneId}&focus=template`} aria-label={t('rooms.applyTemplateFor', { name })}>
              <LayoutTemplate aria-hidden />
              {t('rooms.applyTemplate')}
            </Link>
          </Button>
        )}
        {open && canUpdate && (
          <Button
            variant="secondary"
            size="sm"
            // The whole-version label is long: on a phone it wraps inside the card instead of running past it.
            className="h-auto min-h-8 max-w-full py-1 text-left whitespace-normal"
            onClick={onAutoConnect}
            aria-label={room.zoneId ? t('rooms.autoConnectFor', { name }) : t('rooms.autoConnectAll')}
          >
            <Plug aria-hidden />
            {room.zoneId ? t('rooms.autoConnect') : t('rooms.autoConnectAll')}
          </Button>
        )}
      </div>
    </li>
  )
}
