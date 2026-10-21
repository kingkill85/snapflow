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
