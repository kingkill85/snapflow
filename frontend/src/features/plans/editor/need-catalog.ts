import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import type { FunctionType, PlanNeed } from '@/api/generated/model'
import { useListFunctionTypes } from '@/api/generated/function-types/function-types'
import { useListLoadTypes } from '@/api/generated/load-types/load-types'
import { useListRoomTemplates } from '@/api/generated/room-templates/room-templates'
import { useLocalized } from '@/i18n/localized'

import { needText } from './needs'

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

/** A need's row text in plain words, with the UI language's numbers. */
export function useNeedText(catalog: NeedCatalog) {
  const { t, i18n } = useTranslation('plans')
  const localize = useLocalized()
  const format = useMemo(() => new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 2 }), [i18n.resolvedLanguage])
  return (need: PlanNeed) => needText(need, catalog.functionTypeById, catalog.loadTypeById, localize, (n) => format.format(n), t('needs.unknown'))
}

/** Active function types, plus the need's own one when it is inactive (flagged). */
export function functionTypeOptions(all: FunctionType[], current: string | undefined, localize: ReturnType<typeof useLocalized>, inactive: (name: string) => string) {
  return all.filter((f) => f.isActive || f.id === current).map((f) => ({ value: f.id, label: f.isActive ? localize(f.name) : inactive(localize(f.name)) }))
}

