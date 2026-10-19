import type { FunctionType, LoadType, RoomTemplateLine, RoomTemplateLineWarningsItem } from '@/api/generated/model'

/**
 * What is wrong with a line as it stands now (the backend's line warnings,
 * computed live as the form changes) and whether saving refuses it: an
 * inactive function type or load type is only kept when the stored
 * template has a line with it (D345); such a line is skipped when the
 * template is applied.
 */
export function lineState(line: { functionTypeId: string; loadTypeId: string }, stored: RoomTemplateLine[], fts: FunctionType[], lts: LoadType[]) {
  const ft = fts.find((f) => f.id === line.functionTypeId)
  const lt = line.loadTypeId ? lts.find((l) => l.id === line.loadTypeId) : undefined
  const warnings: RoomTemplateLineWarningsItem[] = []
  if (ft && !ft.isActive) warnings.push('function_type_inactive')
  if (lt && !lt.isActive) warnings.push('load_type_inactive')
  if (ft && lt && ft.loadTypeIds.length > 0 && !ft.loadTypeIds.includes(lt.id)) warnings.push('load_type_not_allowed')
  const keptFunction = stored.some((l) => l.functionTypeId === line.functionTypeId)
  const keptLoad = stored.some((l) => l.functionTypeId === line.functionTypeId && l.loadTypeId === line.loadTypeId)
  const blocked = (warnings.includes('function_type_inactive') && !keptFunction) || ((warnings.includes('load_type_inactive') || warnings.includes('load_type_not_allowed')) && !keptLoad)
  return { warnings, blocked }
}
