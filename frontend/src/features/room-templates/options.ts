import type { FunctionType, LoadType } from '@/api/generated/model'
import type { SelectOption } from '@/components/ui'

// Choices of a need or template line, shared by the room template editor and the plan editor's needs.

/**
 * The function types a line may choose (active ones) plus the line's current
 * one when it is inactive, marked so (D328: kept on existing rows, not chosen anew).
 */
export function functionTypeOptions(all: FunctionType[], current: string, name: (f: FunctionType) => string, inactive: (name: string) => string): SelectOption[] {
  return all.filter((f) => f.isActive || f.id === current).map((f) => ({ value: f.id, label: f.isActive ? name(f) : inactive(name(f)) }))
}

/**
 * The load types allowed for a function type (its list, empty = any), active
 * ones plus the line's current one when inactive or no longer allowed.
 */
export function loadTypeOptions(
  all: LoadType[],
  functionType: FunctionType | undefined,
  current: string,
  name: (l: LoadType) => string,
  inactive: (name: string) => string,
): SelectOption[] {
  const allowed = functionType?.loadTypeIds ?? []
  return all
    .filter((l) => l.id === current || (l.isActive && (allowed.length === 0 || allowed.includes(l.id))))
    .map((l) => ({ value: l.id, label: l.isActive ? name(l) : inactive(name(l)) }))
}
