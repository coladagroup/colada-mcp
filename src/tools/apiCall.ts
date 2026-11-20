import { callBackend } from '../api/backend.js'
import type { App } from '../app.js'
import { messages } from '../errors.js'
import { type CheckedRequest, MAX_RESPONSE_BYTES } from '../policy/index.js'
import { type ApiToolContext, openRealm, type ToolContext } from './run.js'

export interface ApiCallInput {
  realm?: string
  workspace?: string
  service: string
  path: string
  query?: Record<string, string>
  body?: unknown
}

const API_PREVIEW_NOTE =
  'Preview: nothing was sent and no write budget was used. Call api_write again without preview to send this request.'

export function plannedRequest(host: string, input: ApiCallInput, checked: CheckedRequest) {
  return {
    method: checked.method,
    host,
    service: input.service,
    path: input.path,
    query: input.query ?? {},
    headers: Object.keys(checked.headers),
    body: input.body ?? null
  }
}

export async function previewApiCall(app: App, ctx: ApiToolContext, input: ApiCallInput, checked: CheckedRequest) {
  ctx.preview = true
  const { session, directory } = await openRealm(app, ctx, input.realm)
  ctx.workspace = await directory.resolve(input.workspace, { httpStatus: null })
  return { preview: true, note: API_PREVIEW_NOTE, request: plannedRequest(session.host, input, checked) }
}

export async function sendApiCall(
  app: App,
  ctx: ToolContext,
  input: ApiCallInput,
  checked: CheckedRequest,
  maxBytes = MAX_RESPONSE_BYTES
) {
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
      maxBytes,
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
