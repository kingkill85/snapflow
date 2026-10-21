import { useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useListFunctionTypes } from '@/api/generated/function-types/function-types'
import { useListLoadTypes } from '@/api/generated/load-types/load-types'
import type { Connection, Finding, ItemInfo, NeedInfo, Wiring } from '@/api/generated/model'
import { useListOutputKinds } from '@/api/generated/output-kinds/output-kinds'
import { getGetChecksQueryKey, getGetRoomsQueryKey, getGetWiringQueryKey, getListConnectionsQueryKey, useGetWiring } from '@/api/generated/wiring/wiring'
import { useLocalized } from '@/i18n/localized'

import type { FindingNames } from './format'

export const itemKey = (planId: string, itemId: string) => `${planId}/${itemId}`
export const needKey = (planId: string, needId: string) => `${planId}/${needId}`
export const channelKey = (planId: string, itemId: string, kindId: string, no: number) => `${planId}/${itemId}/${kindId}/${no}`

/** Reloads everything that shows connections (wiring view, checks, connection list, room overview) after a change. */
export function useRefreshWiring(versionId: string) {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetWiringQueryKey(versionId) }),
      queryClient.invalidateQueries({ queryKey: getGetChecksQueryKey(versionId) }),
      queryClient.invalidateQueries({ queryKey: getListConnectionsQueryKey(versionId) }),
      queryClient.invalidateQueries({ queryKey: getGetRoomsQueryKey(versionId) }),
    ])
}

export type ChannelRef = { targetPlanId: string; targetItemId: string; outputKindId: string; channelNo: number }

/**
 * The wiring view of a version with lookups and the texts every place that shows connections uses: an item's
 * name (label, else product), a channel ("Dimmer D1 · Dimmer output 3 (Main board)"), a need ("2 × Light ·
 * Spots") and the names a finding's text needs.
 */
/** A translatable text in finding params ({ en, de? }). */
const isText = (v: unknown): v is Record<string, string> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as Record<string, unknown>).en === 'string'

export function useWiringModel(versionId: string, enabled = true) {
  const query = useGetWiring(versionId, { query: { enabled } })
  const kinds = useListOutputKinds({ includeInactive: true })
  const functionTypes = useListFunctionTypes()
  const loadTypes = useListLoadTypes({ includeInactive: true })
  const localize = useLocalized()
  const { t } = useTranslation('checks')
  const model = useMemo(() => {
    const data: Wiring = query.data ?? { items: [], needs: [], connections: [], can: { update: false } }
    const items = new Map<string, ItemInfo>(data.items.map((i) => [itemKey(i.planId, i.itemId), i]))
    const needs = new Map<string, NeedInfo>(data.needs.map((n) => [needKey(n.planId, n.needId), n]))
    const connections = new Map<string, Connection>(data.connections.map((c) => [c.id, c]))
    const byNeed = new Map<string, Connection[]>()
    const byChannel = new Map<string, Connection[]>()
    for (const c of data.connections) {
      const nk = needKey(c.needPlanId, c.needId)
      byNeed.set(nk, [...(byNeed.get(nk) ?? []), c])
      const ck = channelKey(c.targetPlanId, c.targetItemId, c.outputKindId, c.channelNo)
      byChannel.set(ck, [...(byChannel.get(ck) ?? []), c])
    }
    const kindById = new Map((kinds.data?.items ?? []).map((k) => [k.id, k]))
    const kindByKey = new Map((kinds.data?.items ?? []).map((k) => [k.key, k]))
    const ftById = new Map((functionTypes.data?.items ?? []).map((f) => [f.id, f]))
    const ftByKey = new Map((functionTypes.data?.items ?? []).map((f) => [f.key, f]))
    const ltByKey = new Map((loadTypes.data?.items ?? []).map((l) => [l.key, l]))

    const itemName = (item: ItemInfo | undefined) =>
      !item ? t('fallback.item') : item.label.trim() || (item.productName ? localize(item.productName) : t('fallback.item'))
    const kindName = (id: string) => {
      const k = kindById.get(id)
      return k ? localize(k.name) : t('fallback.channel')
    }
    const channelText = (ref: ChannelRef) => {
      const item = items.get(itemKey(ref.targetPlanId, ref.targetItemId))
      return t('channel.text', { item: itemName(item), kind: kindName(ref.outputKindId), no: ref.channelNo, plan: item?.planName ?? '' })
    }
    const kindNameByKey = (key: string) => {
      const k = kindByKey.get(key)
      return k ? localize(k.name) : key
    }
    const functionTypeName = (id: string) => {
      const f = ftById.get(id)
      return f ? localize(f.name) : ''
    }
    const needText = (n: NeedInfo | undefined) => {
      if (!n) return t('fallback.need')
      const name = functionTypeName(n.functionTypeId)
      return [t('need.text', { count: n.quantity, name }), n.label.trim()].filter(Boolean).join(' · ')
    }
    const needPlace = (n: NeedInfo) => [n.planName, n.zoneName || t('need.noZone')].join(' · ')
    /** The names a finding's text needs, resolved from its refs and params; on `openPlanId` (an editor) without that plan's name. */
    const findingNames = (f: Finding, openPlanId?: string): FindingNames => {
      const r = f.refs
      const need = r.planId && r.needId ? needs.get(needKey(r.planId, r.needId)) : undefined
      const item = r.targetPlanId && r.itemId ? items.get(itemKey(r.targetPlanId, r.itemId)) : undefined
      const ftKey = typeof f.params?.functionTypeKey === 'string' ? f.params.functionTypeKey : undefined
      const ltKey = typeof f.params?.loadTypeKey === 'string' ? f.params.loadTypeKey : undefined
      const lt = ltKey ? ltByKey.get(ltKey) : undefined
      const ft = ftKey ? ftByKey.get(ftKey) : undefined
      // Items without channels (gateways, bus devices) and boards without channel modules are not in the
      // wiring view: the API names them in params (label, productName, name).
      const p = f.params ?? {}
      const paramLabel = typeof p.label === 'string' ? p.label.trim() : ''
      const paramProduct = isText(p.productName) ? localize(p.productName) : ''
      const paramItem = f.refs.itemId ? paramLabel || paramProduct || undefined : undefined
      const paramBoard = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : undefined
      return {
        need: need ? `${needText(need)} (${need.planId === openPlanId ? need.zoneName || t('need.noZone') : needPlace(need)})` : undefined,
        item: item ? (item.planId === openPlanId ? itemName(item) : `${itemName(item)} (${item.planName})`) : paramItem,
        channel:
          r.targetPlanId && r.itemId && r.outputKindId && r.channelNo != null
            ? channelText({ targetPlanId: r.targetPlanId, targetItemId: r.itemId, outputKindId: r.outputKindId, channelNo: r.channelNo })
            : undefined,
        board: (r.targetPlanId ? data.items.find((i) => i.planId === r.targetPlanId)?.planName : undefined) ?? paramBoard,
        functionType: ft ? localize(ft.name) : undefined,
        loadType: lt ? localize(lt.name) : undefined,
      }
    }
    return {
      data,
      items,
      needs,
      connections,
      byNeed,
      byChannel,
      kindByKey,
      itemName,
      kindName,
      kindNameByKey,
      channelText,
      needText,
      needPlace,
      functionTypeName,
      findingNames,
      connectionsOfNeed: (planId: string, needId: string) => byNeed.get(needKey(planId, needId)) ?? [],
      connectionsOfChannel: (ref: ChannelRef) => byChannel.get(channelKey(ref.targetPlanId, ref.targetItemId, ref.outputKindId, ref.channelNo)) ?? [],
    }
  }, [query.data, kinds.data, functionTypes.data, loadTypes.data, localize, t])
  return { ...model, query, canUpdate: model.data.can.update }
}

export type WiringModel = ReturnType<typeof useWiringModel>
