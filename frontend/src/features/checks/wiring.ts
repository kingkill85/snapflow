import { useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useListFunctionTypes } from '@/api/generated/function-types/function-types'
import { useListLoadTypes } from '@/api/generated/load-types/load-types'
import type { Connection, Finding, ItemInfo, NeedInfo, Wiring } from '@/api/generated/model'
import { useListOutputKinds } from '@/api/generated/output-kinds/output-kinds'
import { getGetChecksQueryKey, getGetWiringQueryKey, getListConnectionsQueryKey, useGetWiring } from '@/api/generated/wiring/wiring'
import { useLocalized } from '@/i18n/localized'

import type { FindingNames } from './format'

export const itemKey = (planId: string, itemId: string) => `${planId}/${itemId}`
export const needKey = (planId: string, needId: string) => `${planId}/${needId}`
export const channelKey = (planId: string, itemId: string, kindId: string, no: number) => `${planId}/${itemId}/${kindId}/${no}`

/** Reloads everything that shows connections (wiring view, checks, connection list) after a change. */
export function useRefreshWiring(versionId: string) {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetWiringQueryKey(versionId) }),
      queryClient.invalidateQueries({ queryKey: getGetChecksQueryKey(versionId) }),
      queryClient.invalidateQueries({ queryKey: getListConnectionsQueryKey(versionId) }),
    ])
}

export type ChannelRef = { targetPlanId: string; targetItemId: string; outputKindId: string; channelNo: number }

/**
 * The wiring view of a version with lookups and the texts every place that shows connections uses: an item's
 * name (label, else product), a channel ("Dimmer D1 · Dimmer output 3 (Main board)"), a need ("2 × Light ·
 * Spots") and the names a finding's text needs.
 */
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
    /** The names a finding's text needs, resolved from its refs and params. */
    const findingNames = (f: Finding): FindingNames => {
      const r = f.refs
      const need = r.planId && r.needId ? needs.get(needKey(r.planId, r.needId)) : undefined
      const item = r.targetPlanId && r.itemId ? items.get(itemKey(r.targetPlanId, r.itemId)) : undefined
      const ftKey = typeof f.params?.functionTypeKey === 'string' ? f.params.functionTypeKey : undefined
      const ltKey = typeof f.params?.loadTypeKey === 'string' ? f.params.loadTypeKey : undefined
      const lt = ltKey ? ltByKey.get(ltKey) : undefined
      const ft = ftKey ? ftByKey.get(ftKey) : undefined
      return {
        need: need ? `${needText(need)} (${needPlace(need)})` : undefined,
        item: item ? `${itemName(item)} (${item.planName})` : undefined,
        channel:
          r.targetPlanId && r.itemId && r.outputKindId && r.channelNo != null
            ? channelText({ targetPlanId: r.targetPlanId, targetItemId: r.itemId, outputKindId: r.outputKindId, channelNo: r.channelNo })
            : undefined,
        board: r.targetPlanId ? data.items.find((i) => i.planId === r.targetPlanId)?.planName : undefined,
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
