import { useGetBoardContent } from '@/api/generated/plans/plans'

/** A schematic of a board for its card: rails as lines, modules as boxes (drawn from the content, scaled to the card). */
export function BoardThumbnail({ planId }: { planId: string }) {
  const content = useGetBoardContent(planId, { query: { staleTime: 0 } })
  const rows = content.data?.rows ?? []
  const widest = Math.max(1, ...rows.map((r) => r.capacityTe))
  const rowHeight = 5
  const height = Math.max(1, rows.length) * rowHeight + 1
  const width = widest + 1
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" className="size-full p-3" aria-hidden="true" data-testid="board-thumbnail">
      {rows.map((row, i) => {
        const y = 0.5 + i * rowHeight
        return (
          <g key={row.id}>
            <rect x={0.5} y={y + 1.7} width={row.capacityTe} height={0.6} className="fill-line" />
            {(content.data?.modules ?? [])
              .filter((m) => m.rowId === row.id)
              .map((m) => (
                <rect key={m.id} x={0.5 + m.offsetTe + 0.05} y={y} width={Math.max(0.1, m.widthTe - 0.1)} height={4} rx={0.15} className={m.existing ? 'fill-muted/40 stroke-muted' : 'fill-surface stroke-ink/60'} strokeWidth={0.06} />
              ))}
          </g>
        )
      })}
    </svg>
  )
}
