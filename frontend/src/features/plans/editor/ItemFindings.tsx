import type { Finding } from '@/api/generated/model'
import { FindingsList } from '@/features/checks'

import { usePlanWiring } from './plan-wiring'

/** The findings of one item or need in the inspector (D454): the checks' list without headings. */
export function ItemFindings({ findings }: { findings: Finding[] }) {
  const planWiring = usePlanWiring()
  if (findings.length === 0) return null
  return <FindingsList findings={findings} names={planWiring?.wiring.findingNames} headings={false} />
}
