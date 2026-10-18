import { useEffect, useRef, useState } from 'react'

import { ApiError, apiClient } from '@/api/client'
import type { File as StoredFile } from '@/api/generated/model'

/** Where a stored file is served (needs the session cookie, which <img> sends). */
export const fileUrl = (id?: string) => (id ? `/api/files/${id}` : undefined)

/** What the upload accepts (D58); checked here only to spare a long upload, the server decides. */
export const imageTypes = ['image/jpeg', 'image/png', 'image/webp']
export const maxImageMb = 10

/** The error the server would give for this file, if it is obviously wrong. */
export function checkImage(file: Blob): ApiError | undefined {
  if (!imageTypes.includes(file.type)) return new ApiError({ status: 415, code: 'file.type' })
  if (file.size > maxImageMb * 1024 * 1024) return new ApiError({ status: 413, code: 'file.too_large', params: { maxMb: maxImageMb } })
  return undefined
}

/**
 * Uploads an image (POST /api/files). Through the shared API client rather than
 * the generated uploadFile, which offers no upload progress (D69).
 */
export function uploadImage(file: Blob, onProgress?: (fraction: number) => void, signal?: AbortSignal) {
  const data = new FormData()
  data.append('file', file)
  return apiClient<StoredFile>({
    url: '/api/files',
    method: 'POST',
    data,
    signal,
    onUploadProgress: (e) => {
      if (e.total) onProgress?.(e.loaded / e.total)
    },
  })
}

/**
 * Upload state for an ImageUpload: `upload` resolves to the new file id, or
 * undefined if it failed (see `error`) or was cancelled. An upload still
 * running when the component unmounts (e.g. the form restarts on Reload) is
 * aborted and its result ignored.
 */
export function useImageUpload() {
  const [pending, setPending] = useState(false)
  const [progress, setProgress] = useState<number>()
  const [error, setError] = useState<unknown>(null)
  const running = useRef<AbortController | null>(null)
  useEffect(() => () => running.current?.abort(), [])

  const upload = async (file: File): Promise<string | undefined> => {
    setError(null)
    const invalid = checkImage(file)
    if (invalid) {
      setError(invalid)
      return undefined
    }
    running.current?.abort()
    const controller = new AbortController()
    running.current = controller
    setPending(true)
    setProgress(undefined)
    try {
      const stored = await uploadImage(file, setProgress, controller.signal)
      return controller.signal.aborted ? undefined : stored.id
    } catch (e) {
      if (!controller.signal.aborted) setError(e)
      return undefined
    } finally {
      if (running.current === controller) {
        running.current = null
        setPending(false)
      }
    }
  }
  /** Stops a running upload; the image stays as it was. */
  const cancel = () => {
    running.current?.abort()
    running.current = null
    setPending(false)
  }
  return { upload, cancel, pending, progress, error, reset: () => setError(null) }
}
