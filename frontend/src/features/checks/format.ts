import { useTranslation } from 'react-i18next'

import type { Finding } from '@/api/generated/model'
import { formatDecimal, useDecimalSeparator } from '@/catalog/decimal'
import { useLocalized } from '@/i18n/localized'

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
  /** The board (refs.targetPlanId) of board_over_capacity / board_row_over_capacity; else params.name. */
  board?: string
  /** The localized function type (params.functionTypeKey). */
  functionType?: string
  /** The localized load type (params.loadTypeKey). */
  loadType?: string
}

export type Status = 'ok' | 'amber' | 'red' | 'unknown'

/** The badge variant of a reserve status: colour always goes with the status text (`checks:status.*`). */
const statusRank: Record<string, number> = { red: 3, amber: 2, unknown: 1, ok: 0 }

/** The worse of two reserve statuses (a card or header shows the worst of its parts). */
export function worstStatus(a: string, b: string): string {
  return (statusRank[a] ?? 0) >= (statusRank[b] ?? 0) ? a : b
}

/** A board's status as one chip: the worst of its total and its rows (D417). */
export function boardStatus(b: { status: string; rows: { status: string }[] }): string {
  return b.rows.reduce((s, r) => worstStatus(s, r.status), b.status)
}

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
  'power_unknown',
  'board_over_capacity',
  'board_row_over_capacity',
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
  'network_assignment_dangling',
  'address_duplicate',
  'address_outside_line',
  'address_missing',
  'bus_line_address_invalid',
  'bus_line_address_duplicate',
  'address_device_zero',
  // The plans' content warnings (D453): one namespace with the checks codes.
  'variant_deleted',
  'variant_inactive',
  'product_inactive',
  'category_inactive',
  'product_type_inactive',
  'product_type_not_in_project',
  'required_addon_unavailable',
  'addon_unavailable',
  'addon_not_linked',
  'module_width_unknown',
  'module_mounting_floorplan',
  'row_overflow',
  'enclosure_size_unknown',
  'module_overlap',
  'need_function_type_inactive',
  'need_outside_zones',
  'need_load_type_not_allowed',
] as const
export type FindingCode = (typeof findingCodes)[number]

export const unconnectableReasons = ['no_channel_serves', 'no_free_channel', 'limits_exceeded'] as const
export type UnconnectableReason = (typeof unconnectableReasons)[number]

/** Codes with their own wording as a refused candidate (`candidate.*`). */
const candidateCodes = ['channel_overload_w', 'channel_overload_a', 'module_overload_w', 'module_overload_a'] as const
const isCandidateCode = (code: string): code is (typeof candidateCodes)[number] => (candidateCodes as readonly string[]).includes(code)

const isCode = (code: string): code is FindingCode => (findingCodes as readonly string[]).includes(code)

const isI18nText = (v: unknown): v is Record<string, string> => typeof v === 'object' && v !== null && !Array.isArray(v)

const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)

/**
 * A finding in plain words ("Living room: 2 of 5 not connected", "KNX 1:
 * 612 of 640 mA used (reserve 20 %)"): the API's params passed through with
 * numbers in the UI language's format, plus the resolved names.
 */
export function useFindingText() {
  const { t } = useTranslation('checks')
  const separator = useDecimalSeparator()
  const localize = useLocalized()
  /**
   * `candidate`: the rule a candidate in the connect picker breaks, worded as what the connection would do
   * ("would draw 17.39 A at 230 V (at most 16 A)") and without the channel's name for the limits, so equal
   * refusals read alike and can be grouped; other codes read as findings.
   */
  return (finding: Pick<Finding, 'code' | 'params'>, names: FindingNames = {}, candidate = false): string => {
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
      board: names.board ?? text(finding.params?.name) ?? t('fallback.board'),
      target: t(`dangling.${finding.params?.kind === 'bus_line' || finding.params?.kind === 'gateway' ? finding.params.kind : 'other'}`),
      functionType: names.functionType ?? text(finding.params?.functionTypeKey) ?? t('fallback.functionType'),
      loadType:
        names.loadType ??
        text(finding.params?.loadTypeKey) ??
        t(finding.code === 'module_overload_w' ? 'fallback.allLoads' : 'fallback.loadType'),
      motor: motor(finding.params?.motorType),
      needMotor: motor(finding.params?.needMotorType),
      code: finding.code,
    }
    const mixed = finding.params?.mixedLoads === true
    if (candidate && isCandidateCode(finding.code)) {
      if (mixed && finding.code === 'channel_overload_w') return t('candidate.channel_overload_w_mixed', all)
      if (mixed && finding.code === 'channel_overload_a') return t('candidate.channel_overload_a_mixed', all)
      return t(`candidate.${finding.code}`, all)
    }
    // Several load types on a channel: the share of the mix's limit, not an effective limit in W or A (D417).
    if (finding.params?.mixedLoads === true && finding.code === 'channel_overload_w') return t('finding.channel_overload_w_mixed', all)
    if (finding.params?.mixedLoads === true && finding.code === 'channel_overload_a') return t('finding.channel_overload_a_mixed', all)
    if (!isCode(finding.code)) return t('finding.unknown', all)
    const words = t(`finding.${finding.code}`, all)
    // An add-on warning names the add-on (D453).
    const addon = finding.params?.addonProductName
    if (!isI18nText(addon)) return words
    const variant = finding.params?.addonVariantName
    return t('finding.withAddon', { text: words.replace(/\.$/, ''), product: localize(addon), variant: isI18nText(variant) ? localize(variant) : '' })
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
