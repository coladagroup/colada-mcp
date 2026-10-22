import { callBackend } from '../api/backend.js'
import type { App } from '../app.js'
import { messages } from '../errors.js'
import { type CheckedRequest, MAX_RESPONSE_BYTES } from '../policy/index.js'
import { type ApiToolContext, openRealm } from './run.js'

export interface ApiCallInput {
  realm?: string
  workspace?: string
  service: string
  path: string
  query?: Record<string, string>
  body?: unknown
}

export async function sendApiCall(app: App, ctx: ApiToolContext, input: ApiCallInput, checked: CheckedRequest) {
  const { session, directory } = await openRealm(app, ctx, input.realm)
  const workspace = await directory.resolve(input.workspace, ctx.state)
  ctx.workspace = workspace
  const path = `/_gw/${input.service}${input.path}`
  const response = await callBackend(
    app.api,
    session,
    {
      workspaceId: workspace.id,
      method: checked.method,
      path,
      query: queryString(input.query ?? {}),
      headers: checked.headers,
      body: input.body,
      maxBytes: MAX_RESPONSE_BYTES,
      notFound: messages.notFound(checked.method, path, workspace.id)
    },
    ctx.state
  )
  return {
    status: response.status,
    headers: response.returnedHeaders,
    body: response.body,
    ...(response.bodyNote === undefined ? {} : { bodyNote: response.bodyNote })
  }
}

function queryString(query: Record<string, string>): string | undefined {
  const entries = Object.entries(query)
  if (entries.length === 0) return undefined
  return entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')
}
