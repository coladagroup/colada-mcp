import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { CallState } from '../api/backend.js'
import type { App, RealmContext } from '../app.js'
import type { ApiCall } from '../callLog.js'
import { ToolError } from '../errors.js'
import type { ResolvedWorkspace } from '../workspaces.js'

export const realmInput = z
  .string()
  .optional()
  .describe(
    'Keycloak realm of the workspace. Leave it out for the main realm. Pass another realm only when the user names it.'
  )

export function realmShape(app: App) {
  return (app.multiRealm ? { realm: realmInput } : {}) as { realm: typeof realmInput }
}

export const workspaceInput = z
  .string()
  .optional()
  .describe(
    'Workspace id or exact name from list_workspaces for this realm. Required when the realm has more than one workspace. Do not guess: call list_workspaces first.'
  )

export interface ToolContext {
  realm: string | null
  state: CallState
  workspace: ResolvedWorkspace | null
  user?: string | null
}

export interface ApiToolContext extends ToolContext {
  call: ApiCall
}

type Handler<C> = (ctx: C) => Promise<Record<string, unknown>>

export function runTool(
  app: App,
  tool: string,
  params: Record<string, unknown>,
  handler: Handler<ToolContext>
): Promise<CallToolResult> {
  const ctx: ToolContext = { realm: requestedRealm(params), state: { httpStatus: null }, workspace: null }
  return execute(app, tool, ctx, handler, () => ({ params }))
}

export function runApiTool(
  app: App,
  tool: string,
  realm: string | undefined,
  call: ApiCall,
  handler: Handler<ApiToolContext>
): Promise<CallToolResult> {
  const ctx: ApiToolContext = { realm: realm || null, state: { httpStatus: null }, workspace: null, call }
  return execute(app, tool, ctx, handler, () => {
    const { method, service, path, query, ifMatch } = ctx.call
    return { method, service, path, query, ifMatch }
  })
}

export function apiCallOf(input: {
  method: string
  service: string
  path: string
  query?: Record<string, string>
  headers?: Record<string, string>
}): ApiCall {
  return {
    method: /^[A-Za-z]+$/.test(input.method) ? input.method.toUpperCase() : input.method,
    service: input.service,
    path: input.path,
    query: input.query ?? {},
    ifMatch: Object.keys(input.headers ?? {}).some((name) => name.toLowerCase() === 'if-match')
  }
}

async function execute<C extends ToolContext>(
  app: App,
  tool: string,
  ctx: C,
  handler: Handler<C>,
  logFields: () => { params: unknown } | ApiCall
): Promise<CallToolResult> {
  let result: Record<string, unknown> = {}
  let error: string | null = null
  try {
    result = await handler(ctx)
  } catch (err) {
    error = err instanceof ToolError ? err.message : `Unexpected error: ${(err as Error).message}`
  }
  const { realm } = ctx
  const user = ctx.user !== undefined ? ctx.user : app.userOf(realm)
  try {
    await app.deps.callLog({
      time: new Date().toISOString(),
      realm,
      user,
      workspace: ctx.workspace?.id ?? null,
      tool,
      ...logFields(),
      httpStatus: ctx.state.httpStatus
    })
  } catch (err) {
    app.deps.log(`colada-mcp: cannot write the call log (${(err as Error).message})`)
  }
  const payload =
    error === null
      ? { realm, user, workspace: ctx.workspace, ...result }
      : { realm, user, workspace: ctx.workspace, error }
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...(error === null ? {} : { isError: true })
  }
}

export async function openRealm(app: App, ctx: ToolContext, name: string | undefined): Promise<RealmContext> {
  const context = await app.realm(name)
  ctx.realm = context.session.realm
  return context
}

function requestedRealm(params: Record<string, unknown>): string | null {
  return typeof params.realm === 'string' && params.realm !== '' ? params.realm : null
}
