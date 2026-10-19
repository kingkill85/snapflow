import { lazy, Suspense } from 'react'

import { Loading } from '@/components/ui'

// The editor (with Konva) loads on first use, keeping it out of the main bundle (D198).
const PlanEditorPage = lazy(() => import('./editor/PlanEditorPage').then((m) => ({ default: m.PlanEditorPage })))

export function EditorRoute() {
  return (
    <Suspense fallback={<Loading />}>
      <PlanEditorPage />
    </Suspense>
  )
}
