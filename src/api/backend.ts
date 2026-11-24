import type { RealmSession } from '../auth/session.js'
import { fail, ToolError } from '../errors.js'
import type { ApiClient, ApiResponse } from './client.js'

const WRITE_MIN_VALIDITY_SECONDS = 60
const RETURNED_HEADERS = ['Content-Range', 'ETag', 'X-ETag', 'Location'] as const

export interface CallState {
  httpStatus: number | null
}

export interface BackendRequest {
  workspaceId: string | null
  method?: string
  path: string
  query?: string
  headers?: Record<string, string>
  body?: unknown
  maxBytes?: number
  notFound?: string
  forbidden?: string
  serverError?: string
  write?: boolean
}

export interface BackendResponse extends ApiResponse {
  returnedHeaders: Record<string, string>
}

export async function callBackend(
  api: ApiClient,
  session: RealmSession,
  request: BackendRequest,
  state: CallState
): Promise<BackendResponse> {
  const method = request.method ?? 'GET'
  const write = request.write ?? method !== 'GET'
  const target = request.query ? `${request.path}?${request.query}` : request.path
  const minValidity = write ? WRITE_MIN_VALIDITY_SECONDS : undefined
  const token = () =>
    request.workspaceId === null
      ? session.baseToken(minValidity)
      : session.workspaceToken(request.workspaceId, minValidity)
  const send = async () => {
    return api.request(method, session.host, target, await token(), request.headers, {
      body: request.body,
      maxBytes: request.maxBytes,
      write,
      onStatus: (status) => {
        state.httpStatus = status
      }
    })
  }

  let response = await send()
  if (response.status === 401) {
    session.invalidate(request.workspaceId)
    if (write) throw fail.writeUnauthorized(method, request.path)
    response = await send()
    if (response.status === 401) return session.end()
  }
  if (response.status >= 200 && response.status < 300) {
    return { ...response, returnedHeaders: returnedHeaders(response.headers) }
  }
  const error = failure(method, request, response.status)
  const noReason = hasOwnText(request, response.status) ? '' : ' The backend gave no reason.'
  const message = response.errorText
    ? `${error.message} The service said: ${response.errorText}`
    : error.message + noReason
  throw new ToolError(message, error.outcome, error.reason)
}

function failure(method: string, request: BackendRequest, status: number): ToolError {
  if (status === 403) {
    return request.forbidden !== undefined
      ? new ToolError(request.forbidden, 'refused', 'forbidden')
      : fail.forbidden(method, request.path)
  }
  if (status === 404 && request.notFound) return new ToolError(request.notFound, 'refused', 'notFound')
  if (status === 409 || status === 412) return fail.conflict(method, request.path, status)
  if (status === 428) return fail.ifMatchRequired(method, request.path)
  if (status === 500 && request.serverError) return new ToolError(request.serverError, 'backend_error', 'serverError')
  return fail.failed(method, request.path, status)
}

function hasOwnText(request: BackendRequest, status: number): boolean {
  return (
    (status === 403 && request.forbidden !== undefined) ||
    (status === 404 && request.notFound !== undefined) ||
    (status === 500 && request.serverError !== undefined)
  )
}

function returnedHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of RETURNED_HEADERS) {
    const value = headers.get(name)
    if (value !== null) result[name] = value
  }
  return result
}
