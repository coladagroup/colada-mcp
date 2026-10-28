import type { RealmSession } from '../auth/session.js'
import { messages, ToolError } from '../errors.js'
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
    if (write) throw new ToolError(messages.writeUnauthorized(method, request.path))
    response = await send()
    if (response.status === 401) return session.end()
  }
  if (response.status >= 200 && response.status < 300) {
    return { ...response, returnedHeaders: returnedHeaders(response.headers) }
  }
  throw new ToolError(withServiceText(failure(method, request, response.status), response.errorText))
}

function failure(method: string, request: BackendRequest, status: number): string {
  if (status === 403) return request.forbidden ?? messages.forbidden(method, request.path)
  if (status === 404 && request.notFound) return request.notFound
  if (status === 409 || status === 412) return messages.conflict(method, request.path, status)
  if (status === 428) return messages.ifMatchRequired(method, request.path)
  if (status >= 500 && request.serverError) return request.serverError
  return messages.failed(method, request.path, status)
}

function withServiceText(message: string, errorText: string | undefined): string {
  return errorText ? `${message} The service said: ${errorText}` : message
}

function returnedHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of RETURNED_HEADERS) {
    const value = headers.get(name)
    if (value !== null) result[name] = value
  }
  return result
}
