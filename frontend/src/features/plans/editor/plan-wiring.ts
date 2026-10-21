import { createContext, useContext } from 'react'

import type { Finding, ZoneStatus } from '@/api/generated/model'
import type { WiringModel } from '@/features/checks'

/** The editor's connections context (3d), provided by `PlanWiringProvider` in connections.tsx. */
export type PlanWiring = {
  versionId: string
  planId: string
  wiring: WiringModel
  zoneStatus: Map<string, ZoneStatus>
  /** The plan's findings (checks with ?planId=, D454): content warnings, connection and network problems. */
  findings: Finding[]
  connect: (needId: string) => void
  refresh: () => Promise<unknown>
}

export const PlanWiringContext = createContext<PlanWiring | null>(null)

export function usePlanWiring() {
  return useContext(PlanWiringContext)
}

/** The canvas badge of a zone: "✓", "2/5" or "!" with its tone (drawn in light colours, D221). */
export function zoneBadge(status: ZoneStatus | undefined): { text: string; tone: 'success' | 'warning' | 'danger' } | null {
  if (!status) return null
  switch (status.status) {
    case 'covered':
      return { text: '✓', tone: 'success' }
    case 'partial':
      return { text: `${status.connectedUnits}/${status.units}`, tone: 'warning' }
    case 'missing':
      return { text: '!', tone: 'danger' }
  }
  return null
}

