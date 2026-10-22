import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { CallState } from '../api/backend.js'
import type { App, RealmContext } from '../app.js'
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

export async function runTool(
  app: App,
  tool: string,
  params: Record<string, unknown>,
  handler: (ctx: ToolContext) => Promise<Record<string, unknown>>
): Promise<CallToolResult> {
  const ctx: ToolContext = { realm: requestedRealm(params), state: { httpStatus: null }, workspace: null }
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
      params,
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
