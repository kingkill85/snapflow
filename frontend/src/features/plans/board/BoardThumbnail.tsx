import type { BoardSketch } from '@/api/generated/model'

/** A schematic of a board for its card: rails as lines, modules as boxes, drawn from the plan list's sketch (no request per card). */
export function BoardThumbnail({ sketch }: { sketch: BoardSketch }) {
  const rows = sketch.rows
  const widest = Math.max(1, ...rows.map((r) => r.capacityTe), ...sketch.modules.map((m) => m.offsetTe + m.widthTe))
  const rowHeight = 5
  const height = Math.max(1, rows.length) * rowHeight + 1
  const width = widest + 1
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" className="size-full p-3" aria-hidden="true" data-testid="board-thumbnail">
      {rows.map((row, i) => (
        // Rows of the sketch carry no id: the index is the key.
        // eslint-disable-next-line react/no-array-index-key
        <rect key={i} data-testid="sketch-rail" x={0.5} y={0.5 + i * rowHeight + 1.7} width={row.capacityTe} height={0.6} className="fill-line" />
      ))}
      {sketch.modules.map((m, i) => (
        <rect
          // eslint-disable-next-line react/no-array-index-key
          key={i}
          data-testid="sketch-module"
          data-existing={m.existing}
          x={0.5 + m.offsetTe + 0.05}
          y={0.5 + m.row * rowHeight}
          width={Math.max(0.1, m.widthTe - 0.1)}
          height={4}
          rx={0.15}
          className={m.existing ? 'fill-muted/40 stroke-muted' : 'fill-surface stroke-ink/60'}
          strokeWidth={0.06}
        />
      ))}
    </svg>
  )
}
