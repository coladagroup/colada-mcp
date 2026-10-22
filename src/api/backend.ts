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
  const write = method !== 'GET'
  const target = request.query ? `${request.path}?${request.query}` : request.path
  const minValidity = write ? WRITE_MIN_VALIDITY_SECONDS : undefined
  const token = () =>
    request.workspaceId === null
      ? session.baseToken(minValidity)
      : session.workspaceToken(request.workspaceId, minValidity)
  const send = async () => {
    const response = await api.request(method, session.host, target, await token(), request.headers, {
      body: request.body,
      maxBytes: request.maxBytes
    })
    state.httpStatus = response.status
    return response
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
  if (response.status === 403) throw new ToolError(messages.forbidden(method, request.path))
  if (response.status === 404 && request.notFound) throw new ToolError(request.notFound)
  if (response.status === 409 || response.status === 412) {
    throw new ToolError(messages.conflict(method, request.path, response.status))
  }
  if (response.status === 428) throw new ToolError(messages.ifMatchRequired(method, request.path))
  throw new ToolError(messages.failed(method, request.path, response.status))
}

function returnedHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of RETURNED_HEADERS) {
    const value = headers.get(name)
    if (value !== null) result[name] = value
  }
  return result
}
