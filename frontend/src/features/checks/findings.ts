import type { Finding } from '@/api/generated/model'

export const severities = ['error', 'warning', 'info'] as const
export type Severity = (typeof severities)[number]

/** The plan a finding is listed under: the need's plan, else the item's (D454). */
export function findingPlanId(f: Finding): string | undefined {
  return f.refs.planId ?? f.refs.targetPlanId
}

/** The findings that concern one item (placement, module) or need of a plan, e.g. for the editor's inspector. */
export function findingsOf(findings: Finding[], planId: string, id: string): Finding[] {
  return findings.filter((f) => (f.refs.targetPlanId === planId && f.refs.itemId === id) || (f.refs.planId === planId && f.refs.needId === id))
}

/** Whether a finding marks its item on the canvas or board grid: errors and warnings, not notes (D454). */
export const marks = (f: Finding) => f.severity === 'error' || f.severity === 'warning'

/** The ids of a findings map whose findings mark them (D454). */
export function markedIds(byId: Map<string, Finding[]>): Set<string> {
  return new Set([...byId].filter(([, list]) => list.some(marks)).map(([id]) => id))
}
