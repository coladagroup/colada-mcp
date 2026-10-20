import type { RealmSession } from '../auth/session.js'
import { messages, ToolError } from '../errors.js'
import type { ApiClient, ApiResponse } from './client.js'

export interface CallState {
  httpStatus: number | null
}

export interface BackendRequest {
  workspaceId: string | null
  path: string
  query?: string
  headers?: Record<string, string>
  notFound?: string
}

export async function callBackend(
  api: ApiClient,
  session: RealmSession,
  request: BackendRequest,
  state: CallState
): Promise<ApiResponse> {
  const target = request.query ? `${request.path}?${request.query}` : request.path
  const token = () => (request.workspaceId === null ? session.baseToken() : session.workspaceToken(request.workspaceId))
  const send = async () => {
    const response = await api.get(session.host, target, await token(), request.headers)
    state.httpStatus = response.status
    return response
  }

  let response = await send()
  if (response.status === 401) {
    session.invalidate(request.workspaceId)
    response = await send()
    if (response.status === 401) return session.end()
  }
  if (response.status >= 200 && response.status < 300) return response
  if (response.status === 403) throw new ToolError(messages.forbidden(request.path), 403)
  if (response.status === 404 && request.notFound) throw new ToolError(request.notFound, 404)
  throw new ToolError(messages.failed(request.path, response.status), response.status)
}
