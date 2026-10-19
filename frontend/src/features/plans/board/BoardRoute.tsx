import { lazy, Suspense } from 'react'

import { Loading } from '@/components/ui'

// The board editor loads on first use, like the floorplan editor.
const BoardEditorPage = lazy(() => import('./BoardEditorPage').then((m) => ({ default: m.BoardEditorPage })))

export function BoardRoute() {
  return (
    <Suspense fallback={<Loading />}>
      <BoardEditorPage />
    </Suspense>
  )
}
