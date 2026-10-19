import { useMemo } from 'react'

import type { FunctionType, PlanNeed } from '@/api/generated/model'
import { useListFunctionTypes } from '@/api/generated/function-types/function-types'
import { useListLoadTypes } from '@/api/generated/load-types/load-types'
import { useListRoomTemplates } from '@/api/generated/room-templates/room-templates'
import { useNeedText as useNeedLineText } from '@/features/needs'
import { useLocalized } from '@/i18n/localized'

/** Function types, load types (with inactive ones, to name what is stored) and the active room templates. */
export function useNeedCatalog() {
  const functionTypes = useListFunctionTypes()
  const loadTypes = useListLoadTypes({ includeInactive: true })
  const templates = useListRoomTemplates()
  return useMemo(() => {
    const fts = functionTypes.data?.items ?? []
    const lts = loadTypes.data?.items ?? []
    return {
      functionTypes: fts,
      functionTypeById: new Map(fts.map((f) => [f.id, f])),
      loadTypes: lts,
      loadTypeById: new Map(lts.map((l) => [l.id, l])),
      templates: templates.data?.items ?? [],
    }
  }, [functionTypes.data, loadTypes.data, templates.data])
}

export type NeedCatalog = ReturnType<typeof useNeedCatalog>

/** Function types and load types by id, for naming needs. */
export type NeedNames = Pick<NeedCatalog, 'functionTypeById' | 'loadTypeById'>

/**
 * A need of the document in plain words, "3 × Dimmable light · 7.5 W · LED ·
 * Ceiling": the shared need text of `features/needs` (rows, symbol
 * inspector, save errors).
 */
export function useNeedText(catalog: NeedNames) {
  const text = useNeedLineText()
  return (need: Pick<PlanNeed, 'quantity' | 'functionTypeId' | 'powerW' | 'loadTypeId' | 'label'>) =>
    text({
      quantity: need.quantity,
      functionTypeName: catalog.functionTypeById.get(need.functionTypeId)?.name,
      powerW: need.powerW,
      loadTypeName: need.loadTypeId ? catalog.loadTypeById.get(need.loadTypeId)?.name : null,
      label: need.label,
    })
}

/** Active function types, plus the need's own one when it is inactive (flagged). */
export function functionTypeOptions(all: FunctionType[], current: string | undefined, localize: ReturnType<typeof useLocalized>, inactive: (name: string) => string) {
  return all.filter((f) => f.isActive || f.id === current).map((f) => ({ value: f.id, label: f.isActive ? localize(f.name) : inactive(localize(f.name)) }))
}

