import { useTranslation } from 'react-i18next'

import type { Finding } from '@/api/generated/model'
import { formatDecimal, useDecimalSeparator } from '@/catalog/decimal'

/**
 * Names a finding's text needs that the API gives only as ids or keys
 * (refs, functionTypeKey, loadTypeKey): the caller resolves them from the
 * plans and the catalog. A missing name falls back to a generic word
 * ("A need", "a channel").
 */
export type FindingNames = {
  /** The need in words (e.g. the need line "2 × Dimmable light · Ceiling"); else the label from params. */
  need?: string
  /** The device or module (refs.itemId / the connection's target); else the label from params. */
  item?: string
  /** The channel in words, e.g. "Dimmer D1 · ch 3 (Main board)". */
  channel?: string
  /** The board (refs.targetPlanId) of board_over_capacity. */
  board?: string
  /** The localized function type (params.functionTypeKey). */
  functionType?: string
  /** The localized load type (params.loadTypeKey). */
  loadType?: string
}

export type Status = 'ok' | 'amber' | 'red' | 'unknown'

/** The badge variant of a reserve status: colour always goes with the status text (`checks:status.*`). */
export function statusTone(status: Status | string): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'ok':
    case 'covered':
      return 'success'
    case 'amber':
    case 'partial':
      return 'warning'
    case 'red':
    case 'missing':
      return 'danger'
    default:
      return 'neutral'
  }
}

/** Known finding codes (D393); others show `finding.unknown` with the code. */
export const findingCodes = [
  'need_unconnected',
  'need_not_found',
  'target_not_found',
  'channel_not_found',
  'function_not_served',
  'motor_mismatch',
  'units_exceeded',
  'channel_conflict',
  'circuit_not_allowed',
  'channel_overload_w',
  'channel_overload_a',
  'module_overload_w',
  'module_overload_a',
  'limit_unknown',
  'min_load',
  'board_over_capacity',
  'bus_line_no_power_supply',
  'bus_line_current_exceeded',
  'bus_line_devices_exceeded',
  'bus_line_current_reserve',
  'bus_line_devices_reserve',
  'bus_current_unknown',
  'bus_device_unassigned',
  'wireless_no_gateway',
  'gateway_places_reserve',
  'gateway_places_exceeded',
  'gateway_no_router',
] as const
export type FindingCode = (typeof findingCodes)[number]

export const unconnectableReasons = ['no_channel_serves', 'no_free_channel', 'limits_exceeded'] as const
export type UnconnectableReason = (typeof unconnectableReasons)[number]

const isCode = (code: string): code is FindingCode => (findingCodes as readonly string[]).includes(code)

const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)

/**
 * A finding in plain words ("Living room: 2 of 5 not connected", "KNX 1:
 * 612 of 640 mA used (reserve 20 %)"): the API's params passed through with
 * numbers in the UI language's format, plus the resolved names.
 */
export function useFindingText() {
  const { t } = useTranslation('checks')
  const separator = useDecimalSeparator()
  return (finding: Pick<Finding, 'code' | 'params'>, names: FindingNames = {}): string => {
    const values: Record<string, string> = {}
    for (const [key, value] of Object.entries(finding.params ?? {})) {
      if (typeof value === 'number') values[key] = formatDecimal(value, separator)
      else if (typeof value === 'string') values[key] = value
    }
    const label = text(finding.params?.label)
    const motor = (key: unknown) => (key === 'ac' || key === 'dc' ? t(`motor.${key}`) : String(key ?? ''))
    const all = {
      ...values,
      need: names.need ?? label ?? t('fallback.need'),
      item: names.item ?? label ?? t('fallback.item'),
      label: label ?? names.item ?? t('fallback.item'),
      channel: names.channel ?? t('fallback.channel'),
      board: names.board ?? t('fallback.board'),
      functionType: names.functionType ?? text(finding.params?.functionTypeKey) ?? t('fallback.functionType'),
      loadType:
        names.loadType ??
        text(finding.params?.loadTypeKey) ??
        t(finding.code === 'module_overload_w' ? 'fallback.allLoads' : 'fallback.loadType'),
      motor: motor(finding.params?.motorType),
      needMotor: motor(finding.params?.needMotorType),
      code: finding.code,
    }
    return isCode(finding.code) ? t(`finding.${finding.code}`, all) : t('finding.unknown', all)
  }
}

/** Why auto-connect could not connect a need, in plain words (`functionType` resolved by the caller). */
export function useReasonText() {
  const { t } = useTranslation('checks')
  return (reason: string, functionType?: string): string =>
    (unconnectableReasons as readonly string[]).includes(reason)
      ? t(`reason.${reason as UnconnectableReason}`, { functionType: functionType ?? t('fallback.functionType') })
      : reason
}

export const areas = ['needs', 'connections', 'boards', 'networks'] as const
type Area = (typeof areas)[number]

/** The area a finding belongs to (only for grouping the list). */
export function areaOf(code: string): Area {
  if (code === 'need_unconnected' || code === 'units_exceeded') return 'needs'
  if (code === 'board_over_capacity') return 'boards'
  if (code.startsWith('bus_') || code.startsWith('gateway_') || code.startsWith('wireless_')) return 'networks'
  return 'connections'
}

