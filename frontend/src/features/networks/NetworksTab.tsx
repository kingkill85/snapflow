import { ArrowDown, ArrowUp, Eraser, Hash, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { createContext, useContext, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router'

import type { AssignmentInput, BusLineNetwork, Checks, BusMember, BusSystem, Gateway, Networks, WirelessDevice, WirelessSystem } from '@/api/generated/model'
import { useGetChecks } from '@/api/generated/wiring/wiring'
import {
  useAssignAddresses,
  useClearAutomaticAddresses,
  useDeleteBusLine,
  useGetAddresses,
  useGetNetworks,
  useReorderBusLines,
  useSetNetworkAssignments,
} from '@/api/generated/networks/networks'
import {
  Badge,
  Button,
  type Column,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorMessage,
  IconButton,
  Loading,
  Notice,
  RowAction,
  Section,
  Select,
  TextLink,
  TypeBadge,
} from '@/components/ui'
import { StatusChip } from '@/features/checks'
import { versionPath } from '@/features/projects/paths'
import { useLocalized } from '@/i18n/localized'

import { AddressCell } from './AddressCell'
import { AddressesContext, useLinePrefix } from './addresses-context'
import { LineDialog } from './LineDialog'
import { useRefreshNetworks } from './refresh'

/** Content changes in the plan editor: fetched on every visit. */
const everyVisit = { staleTime: 0, refetchOnMount: 'always' } as const

type Item = BusMember | WirelessDevice | Gateway

/** The version's checks (step 3d): reserve statuses of lines and gateways; undefined while loading. */
const ChecksContext = createContext<Checks | undefined>(undefined)

/** Status chips with their captions ("Bus current OK"), the reserve after them. */
function StatusLine({ items, reserve }: { items: { label: string; status: string }[]; reserve: number }) {
  const { t } = useTranslation('networks')
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1">
          {i.label} <StatusChip status={i.status} />
        </span>
      ))}
      <span>{t('checks.reserve', { reserve })}</span>
    </p>
  )
}

/** "Product Variant · Label, Plan": names a device in accessible names. */
function useDeviceName() {
  const localize = useLocalized()
  const product = (item: Item) => [localize(item.productName), localize(item.variantName)].filter(Boolean).join(' ')
  return {
    product,
    full: (item: Item) => `${[product(item), item.label].filter(Boolean).join(' · ')}, ${item.planName}`,
    /** A gateway's name; unlabelled gateways of one product on one plan get their number ("…, Ground floor (2)"). */
    gateway: (g: Gateway, all: Gateway[]) => {
      const full = (x: Item) => `${[product(x), x.label].filter(Boolean).join(' · ')}, ${x.planName}`
      const same = all.filter((x) => full(x) === full(g))
      return same.length > 1 ? `${full(g)} (${same.indexOf(g) + 1})` : full(g)
    },
  }
}

/**
 * The Networks tab of a version (step 3c): bus systems with their lines and
 * members, wireless systems with their gateways and devices, as the API
 * computes them (D363; totals are informational, checks come in 3d). Writers
 * (`can.update`) add, edit, reorder and delete lines and move devices.
 */
export function NetworksTab({ projectId, versionId }: { projectId: string; versionId: string }) {
  const { t } = useTranslation('networks')
  const query = useGetNetworks(versionId, { query: everyVisit })
  const refresh = useRefreshNetworks(versionId)
  const assign = useSetNetworkAssignments()
  const reorder = useReorderBusLines()
  const checks = useGetChecks(versionId, { query: everyVisit })
  const addresses = useGetAddresses(versionId, { query: everyVisit })
  const assignAddresses = useAssignAddresses()
  const clearAddresses = useClearAutomaticAddresses()
  const [assigned, setAssigned] = useState<{ assigned: number; unassigned: number } | null>(null)
  const [clearing, setClearing] = useState(false)
  // Links from the Checks tab (#line-<id>, #gateway-<itemId>): scroll there once the content is shown.
  const { hash } = useLocation()
  const loaded = query.isSuccess
  useEffect(() => {
    if (!loaded || !hash) return
    document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView?.({ block: 'start' })
  }, [loaded, hash])

  if (query.isError) return <ErrorMessage error={query.error} />
  if (query.isPending) return <Loading />
  const data = query.data
  const canUpdate = data.can.update

  const setAssignment = async (assignment: AssignmentInput) => {
    setAssigned(null) // the notice is about the last assign only
    try {
      await assign.mutateAsync({ versionId, data: { assignments: [assignment] } })
    } catch {
      return // shown by ErrorMessage via assign.error
    } finally {
      await refresh()
    }
  }

  /** Swaps a line with its neighbour in the same system; the API takes every line of the version. */
  const move = async (line: BusLineNetwork, by: -1 | 1) => {
    const all = data.busSystems.flatMap((s) => s.lines).sort((a, b) => a.position - b.position)
    const ofSystem = all.filter((l) => l.productTypeId === line.productTypeId)
    const neighbour = ofSystem[ofSystem.findIndex((l) => l.id === line.id) + by]
    if (!neighbour) return
    const ids = all.map((l) => l.id)
    const i = ids.indexOf(line.id)
    const j = ids.indexOf(neighbour.id)
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    setAssigned(null)
    try {
      await reorder.mutateAsync({ versionId, data: { ids } })
    } catch {
      return // shown by ErrorMessage via reorder.error
    } finally {
      await refresh()
    }
  }

  /** Automatic addresses for every line (no ids) or one line; pinned ones stay (D419). */
  const runAssign = async (busLineIds?: string[]) => {
    clearAddresses.reset()
    setAssigned(null)
    try {
      const result = await assignAddresses.mutateAsync({ versionId, data: busLineIds ? { busLineIds } : {} })
      setAssigned({ assigned: result.assigned, unassigned: result.unassigned })
    } catch {
      return // shown by ErrorMessage via assignAddresses.error
    } finally {
      await refresh()
    }
  }
  const confirmClear = async () => {
    try {
      await clearAddresses.mutateAsync({ versionId, params: { auto: true } })
    } catch {
      return // shown in the dialog
    }
    setAssigned(null)
    setClearing(false)
    await refresh()
  }

  if (data.busSystems.length === 0 && data.wirelessSystems.length === 0)
    return <EmptyState title={t('overview.empty')} action={<TextLink to={versionPath(projectId, versionId)}>{t('overview.toPlans')}</TextLink>} />

  const canAddress = !!addresses.data?.can.update
  const addressBusy = assignAddresses.isPending || clearAddresses.isPending
  const actions: Actions | null = canUpdate
    ? { setAssignment: (a) => void setAssignment(a), move: (l, by) => void move(l, by), busy: assign.isPending || reorder.isPending }
    : null
  const assignLine = canAddress && data.busSystems.length > 0 ? (lineId: string) => void runAssign([lineId]) : null

  return (
    <ChecksContext.Provider value={checks.data}>
    <AddressesContext.Provider value={{ versionId, data: addresses.data, onWrite: () => setAssigned(null) }}>
      <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 space-y-1">
          <h2 className="text-lg font-semibold">{t('overview.title')}</h2>
          <p className="text-sm text-muted">{t('overview.description')}</p>
          {!canUpdate && <p className="text-sm text-muted">{t('overview.readOnly')}</p>}
        </div>
        {canAddress && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" disabled={addressBusy} onClick={() => void runAssign()}>
              <Hash aria-hidden /> {t('address.assignAll')}
            </Button>
            <Button
              variant="secondary"
              disabled={addressBusy}
              onClick={() => {
                clearAddresses.reset()
                setAssigned(null)
                setClearing(true)
              }}
            >
              <Eraser aria-hidden /> {t('address.clearAuto')}
            </Button>
          </div>
        )}
      </div>
      {assign.error && <ErrorMessage error={assign.error} />}
      {reorder.error && <ErrorMessage error={reorder.error} />}
      {addresses.error && <ErrorMessage error={addresses.error} />}
      {assignAddresses.error && <ErrorMessage error={assignAddresses.error} />}
      {assigned && (
        <Notice tone={assigned.unassigned > 0 ? 'warning' : 'success'}>
          {t('address.assigned', { count: assigned.assigned })}
          {assigned.unassigned > 0 && <> {t('address.unassigned', { count: assigned.unassigned })}</>}
        </Notice>
      )}

      {data.busSystems.map((system) => (
        <BusSystemSection key={system.productType.id} versionId={versionId} system={system} actions={actions} assignLine={assignLine} assignBusy={addressBusy} />
      ))}
      {data.wirelessSystems.map((system) => (
        <WirelessSystemSection key={system.productType.id} system={system} actions={actions} />
      ))}
      </div>
      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        title={t('address.clearTitle')}
        message={t('address.clearMessage')}
        confirmLabel={t('address.clearConfirm')}
        pending={clearAddresses.isPending}
        onConfirm={() => void confirmClear()}
        error={<ErrorMessage error={clearAddresses.error} />}
      />
    </AddressesContext.Provider>
    </ChecksContext.Provider>
  )
}

/** What a writer may do; null for readers and read-only projects. */
type Actions = {
  setAssignment: (assignment: AssignmentInput) => void
  move: (line: BusLineNetwork, by: -1 | 1) => void
  busy: boolean
}

/** The system's badge and name above its content (Section titles are plain text). */
function SystemHeader({ system }: { system: Networks['busSystems'][number]['productType'] }) {
  const localize = useLocalized()
  return (
    <TypeBadge color={system.color} abbreviation={system.abbreviation}>
      <span className="text-sm text-muted">{localize(system.name)}</span>
    </TypeBadge>
  )
}

function BusSystemSection({
  versionId,
  system,
  actions,
  assignLine,
  assignBusy,
}: {
  versionId: string
  system: BusSystem
  actions: Actions | null
  /** Assigns automatic addresses on one line; null without addresses.update. */
  assignLine: ((lineId: string) => void) | null
  assignBusy: boolean
}) {
  const { t } = useTranslation('networks')
  const { t: tCommon } = useTranslation()
  const localize = useLocalized()
  const refresh = useRefreshNetworks(versionId)
  const remove = useDeleteBusLine()
  const [dialog, setDialog] = useState<{ item: BusLineNetwork | null } | null>(null)
  const [deleting, setDeleting] = useState<BusLineNetwork | null>(null)
  const name = localize(system.productType.name)

  const confirmDelete = async () => {
    if (!deleting) return
    try {
      await remove.mutateAsync({ versionId, id: deleting.id })
    } catch {
      return // shown in the dialog
    }
    await refresh()
    setDeleting(null)
  }

  return (
    <Section
      title={name}
      description={t('bus.systemDescription')}
      actions={
        actions && (
          <Button variant="secondary" onClick={() => setDialog({ item: null })}>
            <Plus aria-hidden /> {t('bus.addLine')}
          </Button>
        )
      }
    >
      <SystemHeader system={system.productType} />
      <ol aria-label={t('bus.lines', { system: name })} className="space-y-6">
        {system.lines.map((line, index) => (
          <li key={line.id}>
            <LineBlock
              line={line}
              lines={system.lines}
              first={index === 0}
              last={index === system.lines.length - 1}
              lastWithDevices={system.lines.length === 1 && line.members.length > 0}
              actions={actions}
              onAssign={assignLine ? () => assignLine(line.id) : null}
              assignBusy={assignBusy}
              onEdit={() => setDialog({ item: line })}
              onDelete={() => {
                remove.reset()
                setDeleting(line)
              }}
            />
          </li>
        ))}
      </ol>
      {system.unassigned.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-medium">{t('bus.unassigned')}</h3>
          <Notice tone="warning">{t('bus.unassignedNotice')}</Notice>
          <MemberTable label={`${name}: ${t('bus.unassigned')}`} members={system.unassigned} lines={[]} actions={null} />
        </div>
      )}

      <LineDialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        versionId={versionId}
        productTypeId={system.productType.id}
        item={dialog?.item ?? null}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('bus.deleteTitle')}
        message={t('bus.deleteMessage', { name: deleting?.name ?? '' })}
        confirmLabel={tCommon('action.delete')}
        pending={remove.isPending}
        onConfirm={() => void confirmDelete()}
        error={<ErrorMessage error={remove.error} />}
      />
    </Section>
  )
}

type LineBlockProps = {
  line: BusLineNetwork
  lines: BusLineNetwork[]
  first: boolean
  last: boolean
  /** The system's only line while it has devices: the server refuses its delete (D451). */
  lastWithDevices: boolean
  actions: Actions | null
  onAssign: (() => void) | null
  assignBusy: boolean
  onEdit: () => void
  onDelete: () => void
}

/** One bus line: name, address, informational totals, controls and its members. */
function LineBlock({ line, lines, first, last, lastWithDevices, actions, onAssign, assignBusy, onEdit, onDelete }: LineBlockProps) {
  const { t } = useTranslation('networks')
  const { t: tCommon } = useTranslation()
  const pinned = line.members.some((m) => m.pinned)
  const check = useContext(ChecksContext)?.busLines.find((b) => b.busLineId === line.id)
  const prefix = useLinePrefix(line.id)
  return (
    <div className="scroll-mt-20 space-y-2" id={`line-${line.id}`} data-testid={`bus-line-${line.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line pb-2">
        <div className="min-w-0 space-y-0.5">
          <h3 className="font-medium break-words">{line.name}</h3>
          {line.address && <p className="text-xs text-muted">{t('bus.address', { address: line.address })}</p>}
          {prefix?.prefix && (
            <p className="text-xs text-muted">{prefix.default ? t('address.prefixDefault', { prefix: prefix.prefix }) : t('address.prefix', { prefix: prefix.prefix })}</p>
          )}
          <p className="text-sm text-muted tabular-nums">
            {line.devicesMax == null ? t('bus.devices', { count: line.deviceCount }) : t('bus.devicesOfMax', { count: line.deviceCount, max: line.devicesMax })} · {t('bus.current', { used: line.busCurrentUsedMa, supplied: line.busCurrentSuppliedMa })}
            {line.unknownCurrentCount > 0 && <> · {t('bus.unknownCurrent', { count: line.unknownCurrentCount })}</>}
          </p>
          {check && (
            <StatusLine
              reserve={check.reservePercent}
              items={[
                { label: t('checks.current'), status: check.currentStatus },
                { label: t('checks.devices'), status: check.devicesStatus },
              ]}
            />
          )}
        </div>
        {(actions || onAssign) && (
          <div className="flex flex-wrap items-center gap-2">
            {onAssign && (
              <RowAction icon={<Hash aria-hidden />} label={t('address.assign')} aria-label={t('address.assignLine', { name: line.name })} disabled={assignBusy} onClick={onAssign} />
            )}
            {actions && (
              <>
                <IconButton label={t('bus.moveUp', { name: line.name })} icon={<ArrowUp />} disabled={first || actions.busy} onClick={() => actions.move(line, -1)} />
                <IconButton label={t('bus.moveDown', { name: line.name })} icon={<ArrowDown />} disabled={last || actions.busy} onClick={() => actions.move(line, 1)} />
                <RowAction icon={<Pencil aria-hidden />} label={tCommon('action.edit')} aria-label={t('bus.editLine', { name: line.name })} onClick={onEdit} />
                <RowAction
                  icon={<Trash2 aria-hidden />}
                  variant="danger-quiet"
                  label={tCommon('action.delete')}
                  aria-label={t('bus.deleteLine', { name: line.name })}
                  title={lastWithDevices ? t('bus.deleteLast') : pinned ? t('bus.deleteBlocked') : tCommon('action.delete')}
                  disabled={pinned || lastWithDevices}
                  onClick={onDelete}
                />
              </>
            )}
          </div>
        )}
      </div>
      {prefix?.invalid && <Notice tone="warning">{t('address.lineInvalid', { address: line.address })}</Notice>}
      {prefix?.noPrefix && <Notice tone="warning">{t('address.lineNoPrefix')}</Notice>}
      <MemberTable label={line.name} members={line.members} lines={lines} actions={actions} lineId={line.id} />
    </div>
  )
}

function MemberTable({
  label,
  members,
  lines,
  actions,
  lineId,
}: {
  label: string
  members: BusMember[]
  lines: BusLineNetwork[]
  actions: Actions | null
  lineId?: string
}) {
  const { t } = useTranslation('networks')
  const names = useDeviceName()
  const options = lines.map((l) => ({ value: l.id, label: l.name }))
  const current = (m: BusMember) => {
    if (m.powerSupply) return t('bus.supplied', { value: m.busCurrentSuppliedMa ?? 0 })
    if (m.busCurrentUsedMa === undefined) return t('bus.unknown')
    return m.busCurrentUsedMaDefault ? t('bus.usedDefault', { value: m.busCurrentUsedMa }) : t('bus.used', { value: m.busCurrentUsedMa })
  }
  const columns: Column<BusMember>[] = [
    { header: t('columns.device'), mobile: 'title', cell: (m) => <DeviceCell item={m} /> },
    { header: t('columns.plan'), cell: (m) => m.planName },
    { header: t('columns.label'), cell: (m) => m.label },
    {
      header: t('columns.current'),
      cell: (m) => (
        <span className="flex flex-wrap items-center gap-2 tabular-nums">
          {current(m)}
          {m.powerSupply && <Badge variant="primary">{t('bus.powerSupply')}</Badge>}
        </span>
      ),
    },
  ]
  if (lineId !== undefined) columns.push({ header: t('columns.assignment'), cell: (m) => <AssignmentBadge pinned={m.pinned} /> })
  columns.push({ header: t('columns.address'), cell: (m) => <AddressCell device={m} name={names.full(m)} /> })
  if (actions && lineId !== undefined) {
    columns.push({
      header: t('columns.line'),
      cell: (m) => (
        <Select
          aria-label={t('bus.lineOf', { device: names.full(m) })}
          value={lineId}
          options={options}
          disabled={actions.busy || lines.length < 2}
          onValueChange={(busLineId) => busLineId !== lineId && actions.setAssignment({ planId: m.planId, itemId: m.itemId, busLineId })}
          className="min-w-36"
        />
      ),
    })
  }
  return (
    <DataTable
      label={label}
      rows={members}
      columns={columns}
      rowKey={(m) => `${m.planId}:${m.itemId}`}
      empty={<p className="text-sm text-muted">{t('bus.noMembers')}</p>}
      actions={actions && lineId !== undefined ? (m) => m.pinned && <ResetAction disabled={actions.busy} onClick={() => actions.setAssignment({ planId: m.planId, itemId: m.itemId })} /> : undefined}
    />
  )
}

function WirelessSystemSection({ system, actions }: { system: WirelessSystem; actions: Actions | null }) {
  const { t } = useTranslation('networks')
  const localize = useLocalized()
  const names = useDeviceName()
  const name = localize(system.productType.name)
  const checks = useContext(ChecksContext)
  return (
    <Section title={name} description={t('wireless.systemDescription')}>
      <SystemHeader system={system.productType} />
      <ol aria-label={name} className="space-y-6">
        {system.gateways.map((gateway) => {
          const check = checks?.gateways.find((g) => g.planId === gateway.planId && g.itemId === gateway.itemId)
          return (
          <li key={`${gateway.planId}:${gateway.itemId}`} id={`gateway-${gateway.itemId}`} className="scroll-mt-20 space-y-2">
            <div className="space-y-0.5 border-b border-line pb-2">
              <h3 className="font-medium break-words">{names.gateway(gateway, system.gateways)}</h3>
              <p className="text-sm text-muted tabular-nums">
                {t('wireless.places', { used: gateway.wirelessPlacesUsed, supplied: gateway.wirelessPlacesSupplied })}
                {gateway.unknownPlacesCount > 0 && <> · {t('wireless.unknownPlaces', { count: gateway.unknownPlacesCount })}</>}
              </p>
              {check && <StatusLine reserve={check.reservePercent} items={[{ label: t('checks.places'), status: check.status }]} />}
            </div>
            <DeviceTable label={names.gateway(gateway, system.gateways)} devices={gateway.devices} gateways={system.gateways} gateway={gateway} actions={actions} />
          </li>
          )
        })}
      </ol>
      {system.unassigned.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-medium">{t('wireless.unassigned')}</h3>
          <Notice tone="warning">{t('wireless.unassignedNotice')}</Notice>
          <DeviceTable label={`${name}: ${t('wireless.unassigned')}`} devices={system.unassigned} gateways={[]} actions={null} />
        </div>
      )}
    </Section>
  )
}

const gatewayKey = (g: { planId: string; itemId: string }) => `${g.planId}:${g.itemId}`

function DeviceTable({
  label,
  devices,
  gateways,
  gateway,
  actions,
}: {
  label: string
  devices: WirelessDevice[]
  gateways: Gateway[]
  gateway?: Gateway
  actions: Actions | null
}) {
  const { t } = useTranslation('networks')
  const names = useDeviceName()
  const options = gateways.map((g) => ({ value: gatewayKey(g), label: names.gateway(g, gateways) }))
  const places = (d: WirelessDevice) => {
    if (d.wirelessPlacesUsed === undefined) return t('wireless.unknown')
    return d.wirelessPlacesUsedDefault ? t('wireless.usedPlacesDefault', { value: d.wirelessPlacesUsed }) : t('wireless.usedPlaces', { value: d.wirelessPlacesUsed })
  }
  const columns: Column<WirelessDevice>[] = [
    { header: t('columns.device'), mobile: 'title', cell: (d) => <DeviceCell item={d} /> },
    { header: t('columns.plan'), cell: (d) => d.planName },
    { header: t('columns.label'), cell: (d) => d.label },
    { header: t('columns.places'), cell: (d) => <span className="tabular-nums">{places(d)}</span> },
  ]
  if (gateway) columns.push({ header: t('columns.assignment'), cell: (d) => <AssignmentBadge pinned={d.pinned} /> })
  columns.push({ header: t('columns.address'), cell: (d) => <AddressCell device={d} name={names.full(d)} /> })
  if (actions && gateway) {
    const value = gatewayKey(gateway)
    columns.push({
      header: t('columns.gateway'),
      cell: (d) => (
        <Select
          aria-label={t('wireless.gatewayOf', { device: names.full(d) })}
          value={value}
          options={options}
          disabled={actions.busy || gateways.length < 2}
          onValueChange={(next) => {
            const target = gateways.find((g) => gatewayKey(g) === next)
            if (target && next !== value) actions.setAssignment({ planId: d.planId, itemId: d.itemId, gatewayPlanId: target.planId, gatewayItemId: target.itemId })
          }}
          className="min-w-48"
        />
      ),
    })
  }
  return (
    <DataTable
      label={label}
      rows={devices}
      columns={columns}
      rowKey={(d) => `${d.planId}:${d.itemId}`}
      empty={<p className="text-sm text-muted">{t('wireless.noDevices')}</p>}
      actions={actions && gateway ? (d) => d.pinned && <ResetAction disabled={actions.busy} onClick={() => actions.setAssignment({ planId: d.planId, itemId: d.itemId })} /> : undefined}
    />
  )
}

/** Product and variant with the model number below; "Existing" for existing devices. */
function DeviceCell({ item }: { item: Item }) {
  const { t } = useTranslation('networks')
  const names = useDeviceName()
  return (
    <span className="block min-w-0 space-y-0.5">
      <span className="flex flex-wrap items-center gap-2">
        <span className="break-words">{names.product(item)}</span>
        {item.existing && <Badge>{t('device.existing')}</Badge>}
      </span>
      <span className="block text-xs break-words text-muted">{item.modelNumber}</span>
    </span>
  )
}

function AssignmentBadge({ pinned }: { pinned: boolean }) {
  const { t } = useTranslation('networks')
  return pinned ? <Badge variant="primary">{t('assignment.pinned')}</Badge> : <Badge>{t('assignment.default')}</Badge>
}

function ResetAction({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const { t } = useTranslation('networks')
  return <RowAction icon={<RotateCcw aria-hidden />} label={t('assignment.reset')} disabled={disabled} onClick={onClick} />
}
