import type { RealmSession } from '../auth/session.js'
import { messages, ToolError } from '../errors.js'
import { type BackendRequest, type CallState, callBackend } from './backend.js'
import type { ApiClient } from './client.js'

export const PAGE_SIZE = 100

export interface Page {
  items: unknown[]
  total: number
}

export async function fetchPage(
  api: ApiClient,
  session: RealmSession,
  request: BackendRequest,
  unit: string,
  start: number,
  state: CallState
): Promise<Page> {
  const response = await callBackend(
    api,
    session,
    { ...request, headers: { ...request.headers, Range: `${unit} ${start}-${start + PAGE_SIZE}` } },
    state
  )
  const total = response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1]
  if (total === undefined || !Array.isArray(response.body)) {
    throw new ToolError(messages.failed('GET', request.path, response.status))
  }
  return { items: response.body, total: Number(total) }
}
