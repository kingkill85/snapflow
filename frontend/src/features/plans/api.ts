import { ApiError, apiClient } from '@/api/client'
import type { BoardContentInput, Plan, PlanContentInput } from '@/api/generated/model'

// Plan create and update take multipart bodies. They go through the shared
// API client rather than the generated createPlan/updatePlan, which send the
// name as a Blob and offer no upload progress (D69, D200).

/** Floorplan images the server takes (D195); checked here only to spare a long upload. */
export const planImageTypes = ['image/jpeg', 'image/png', 'image/webp']
export const maxPlanImageMb = 20

export function checkPlanImage(file: Blob): ApiError | undefined {
  if (!planImageTypes.includes(file.type)) return new ApiError({ status: 415, code: 'file.type' })
  if (file.size > maxPlanImageMb * 1024 * 1024) return new ApiError({ status: 413, code: 'file.too_large', params: { maxMb: maxPlanImageMb } })
  return undefined
}

type Progress = (fraction: number) => void
const progressOf = (onProgress?: Progress) => (e: { loaded: number; total?: number }) => {
  if (e.total) onProgress?.(e.loaded / e.total)
}

export function createPlanWithImage(versionId: string, name: string, image: File, onProgress?: Progress) {
  const data = new FormData()
  data.append('name', name)
  data.append('image', image)
  return apiClient<Plan>({ url: `/api/versions/${versionId}/plans`, method: 'POST', data, onUploadProgress: progressOf(onProgress) })
}

export function updatePlanWithImage(plan: Plan, name: string, image: File | undefined, onProgress?: Progress) {
  const data = new FormData()
  data.append('name', name)
  data.append('expectedUpdatedAt', plan.updatedAt)
  if (image) data.append('image', image)
  return apiClient<Plan>({ url: `/api/plans/${plan.id}`, method: 'PUT', data, onUploadProgress: progressOf(onProgress) })
}

/** Releases the lock while the page unloads (a normal request may be cancelled then). */
export function releaseLockOnUnload(planId: string) {
  try {
    void fetch(`/api/plans/${planId}/lock`, { method: 'DELETE', keepalive: true, credentials: 'same-origin' }).catch(() => undefined)
  } catch {
    // nothing to do while unloading
  }
}

/** Keepalive requests may carry at most 64 KiB (all of a page's together); larger contents cannot be sent while unloading. */
const keepaliveLimit = 60_000

/**
 * A last save of pending content while the page unloads (tab closed or
 * reloaded, D215): a `keepalive` PUT, which the browser completes after the
 * page is gone. Returns false when it cannot be sent (content over the
 * keepalive limit); the `beforeunload` prompt has warned then.
 */
export function saveOnUnload(planId: string, input: PlanContentInput | BoardContentInput, part: 'content' | 'board' = 'content'): boolean {
  const body = JSON.stringify(input)
  if (new Blob([body]).size > keepaliveLimit) return false
  try {
    void fetch(`/api/plans/${planId}/${part}`, {
      method: 'PUT',
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).catch(() => undefined)
    return true
  } catch {
    return false
  }
}

/** A plan with a background image (kind floorplan); boards have none. */
export type Floorplan = Plan & { image: NonNullable<Plan['image']> }

export function isFloorplan(plan: Plan): plan is Floorplan {
  return plan.kind === 'floorplan' && plan.image !== null
}
