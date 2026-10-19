import axios, { type AxiosError, type AxiosRequestConfig } from 'axios'

import type { Error as ProblemBody } from './generated/model'

export const http = axios.create({ baseURL: '/' })

/** An API error with a stable code; translate it with `useErrorMessage`. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly params: Record<string, unknown>
  readonly fields: NonNullable<ProblemBody['fields']>

  constructor(body: ProblemBody) {
    super(body.detail ?? body.code)
    this.status = body.status
    this.code = body.code
    this.params = body.params ?? {}
    this.fields = body.fields ?? []
  }
}

function toApiError(error: AxiosError<ProblemBody>): ApiError {
  const body = error.response?.data
  if (body && typeof body === 'object' && 'code' in body) return new ApiError(body)
  return new ApiError({
    status: error.response?.status ?? 0,
    code: error.response ? 'server.error' : 'network.unavailable',
    detail: error.message,
  })
}

/** A blob response's error body (a file endpoint) is the problem JSON as a blob. */
async function readBlobError(error: unknown): Promise<unknown> {
  if (axios.isAxiosError(error) && error.response?.data instanceof Blob) {
    try {
      error.response.data = JSON.parse(await error.response.data.text())
    } catch {
      error.response.data = undefined
    }
  }
  return error
}

/** Mutator used by every generated hook (see orval.config.ts). */
export async function apiClient<T>(config: AxiosRequestConfig): Promise<T> {
  try {
    const response = await http.request<T>(config)
    return response.data
  } catch (caught) {
    const error = await readBlobError(caught)
    throw axios.isAxiosError<ProblemBody>(error) ? toApiError(error) : error
  }
}

/** The file name of a Content-Disposition header (RFC 6266: filename* first). */
export function dispositionFileName(header: string | undefined, fallback: string): string {
  if (!header) return fallback
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (star) {
    try {
      return decodeURIComponent(star[1])
    } catch {
      // fall through to the plain name
    }
  }
  const plain = /filename="([^"]*)"/i.exec(header)
  return plain?.[1] || fallback
}

/**
 * Fetches a file endpoint as a blob with the file name the API sends
 * (exports are fetched, so an API error can be shown); errors are
 * `ApiError`s like every other call.
 */
export async function fetchFile(url: string, params?: Record<string, string>): Promise<{ blob: Blob; fileName: string }> {
  try {
    const response = await http.request<Blob>({ url, method: 'GET', params, responseType: 'blob' })
    const fallback = url.split('/').pop() ?? 'download'
    return { blob: response.data, fileName: dispositionFileName(response.headers['content-disposition'] as string | undefined, fallback) }
  } catch (caught) {
    const error = await readBlobError(caught)
    throw axios.isAxiosError<ProblemBody>(error) ? toApiError(error) : error
  }
}

export type ErrorType<E> = E extends ProblemBody ? ApiError : ApiError
export type BodyType<B> = B
