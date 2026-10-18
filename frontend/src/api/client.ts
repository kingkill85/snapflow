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

/** Mutator used by every generated hook (see orval.config.ts). */
export async function apiClient<T>(config: AxiosRequestConfig): Promise<T> {
  try {
    const response = await http.request<T>(config)
    return response.data
  } catch (error) {
    throw axios.isAxiosError(error) ? toApiError(error) : error
  }
}

export type ErrorType<E> = E extends ProblemBody ? ApiError : ApiError
export type BodyType<B> = B
