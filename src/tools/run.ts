import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { CallState } from '../api/backend.js'
import type { App, RealmContext } from '../app.js'
import type { ApiCall, CallOutcome, FirebaseCall, FirebaseWriteCall, NoWriteCall } from '../callLog.js'
import { fail, messages, ToolError } from '../errors.js'
import { IDENTITY_INPUT_FIELDS } from '../firebase/policy/writes.js'
import { inputHash, isProdHost, PREVIEW_NOTE } from '../preview.js'
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

export const previewInput = z
  .boolean()
  .optional()
  .describe('true: run every check and read, return the writes it would send, and send nothing.')

export const previewIdInput = z
  .string()
  .max(100)
  .optional()
  .describe(
    'previewId from a preview of this tool with the same input. Required on prod hosts; valid 10 minutes, works once.'
  )

export const previewShape = { preview: previewInput, previewId: previewIdInput }

export function withoutPreview<T extends { preview?: boolean; previewId?: string }>(params: T): T {
  const { preview: _preview, previewId: _previewId, ...input } = params
  return input as T
}

export interface ToolContext {
  realm: string | null
  state: CallState
  workspace: ResolvedWorkspace | null
  user?: string | null
  preview?: boolean
}

export interface ApiToolContext extends ToolContext {
  call: ApiCall
}

type Handler<C> = (ctx: C) => Promise<Record<string, unknown>>

type LogFields = ({ params: unknown } | ApiCall | FirebaseCall | FirebaseWriteCall | NoWriteCall) & {
  httpStatus?: number | null
  outcome?: CallOutcome
  reason?: string | null
}

export function runTool(
  app: App,
  tool: string,
  params: Record<string, unknown>,
  handler: Handler<ToolContext>
): Promise<CallToolResult> {
  const ctx: ToolContext = { realm: requestedRealm(params), state: { httpStatus: null }, workspace: null }
  return execute(app, tool, ctx, handler, () => ({ params }))
}

export function runTextTool(app: App, tool: string, text: string): Promise<CallToolResult> {
  const ctx: ToolContext = { realm: null, state: { httpStatus: null }, workspace: null }
  return execute(
    app,
    tool,
    ctx,
    async () => ({}),
    () => ({ params: {} }),
    text
  )
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

export interface BatchLine extends ApiCall {
  httpStatus: number | null
  outcome?: CallOutcome
  reason?: string | null
}

export interface ApiBatchToolContext extends ToolContext {
  lines: BatchLine[]
}

export function runApiBatchTool(
  app: App,
  tool: string,
  realm: string | undefined,
  calls: ApiCall[],
  handler: Handler<ApiBatchToolContext>
): Promise<CallToolResult> {
  const ctx: ApiBatchToolContext = {
    realm: realm || null,
    state: { httpStatus: null },
    workspace: null,
    lines: calls.map((call) => ({ ...call, httpStatus: null }))
  }
  return execute(app, tool, ctx, handler, () => ctx.lines.map((line) => ({ ...line })))
}

export interface FirebaseToolContext extends ToolContext {
  call: FirebaseCall
}

export function runFirebaseTool(
  app: App,
  tool: string,
  realm: string | undefined,
  call: FirebaseCall,
  handler: Handler<FirebaseToolContext>
): Promise<CallToolResult> {
  const ctx: FirebaseToolContext = { realm: realm || null, state: { httpStatus: null }, workspace: null, call }
  return execute(app, tool, ctx, handler, () => {
    const { app: name, store, path, query } = ctx.call
    return { app: name, store, path, query }
  })
}

export interface WriteRecord extends FirebaseWriteCall {
  httpStatus: number | null
}

export interface CapturedWrite {
  method: string
  path: string
  ifMatch?: true
  body: unknown
}

export interface FirebaseWriteToolContext extends ToolContext {
  checkedUsers: Set<string>
  writes: WriteRecord[]
  preview: boolean
  captured: CapturedWrite[]
}

export const WRITE_TOOL_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const

export function writeInput<T extends z.ZodRawShape>(shape: T) {
  return z.looseObject(shape).superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(shape, key)) continue
      const identity = (IDENTITY_INPUT_FIELDS as readonly string[]).includes(key)
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: identity ? messages.writeIdentityField(key) : messages.writeUnknownField(key)
      })
    }
  })
}

export function runFirebaseWriteTool(
  app: App,
  tool: string,
  params: Record<string, unknown>,
  target: string | null,
  handler: Handler<FirebaseWriteToolContext>
): Promise<CallToolResult> {
  const realm = typeof params.realm === 'string' ? params.realm : undefined
  const ctx: FirebaseWriteToolContext = {
    realm: realm || null,
    state: { httpStatus: null },
    workspace: null,
    checkedUsers: new Set(),
    writes: [],
    preview: params.preview === true,
    captured: []
  }
  const hash = inputHash(tool, params)
  const run: Handler<FirebaseWriteToolContext> = async (context) => {
    if (!context.preview) {
      const { session } = await openRealm(app, context, realm)
      const previewId = typeof params.previewId === 'string' ? params.previewId : undefined
      if (isProdHost(session.host) && !app.previews.redeem(previewId, hash)) {
        throw fail.previewRequired(tool, session.host)
      }
      return handler(context)
    }
    const { written: _written, ...result } = await handler(context)
    return {
      preview: true,
      previewId: app.previews.issue(hash),
      note: PREVIEW_NOTE,
      result,
      writes: context.captured
    }
  }
  const noWrite: NoWriteCall = {
    app: 'campaigns',
    store: 'rtdb',
    method: null,
    path: target,
    paths: null,
    ifMatch: false,
    retries: 0
  }
  return execute(app, tool, ctx, run, () =>
    ctx.writes.length > 0 ? ctx.writes.map((write) => ({ ...write })) : { ...noWrite, httpStatus: null }
  )
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
  logFields: () => LogFields | LogFields[],
  plainText?: string
): Promise<CallToolResult> {
  let result: Record<string, unknown> = {}
  let error: string | null = null
  let outcome: CallOutcome = 'ok'
  let reason: string | null = null
  try {
    result = await handler(ctx)
  } catch (err) {
    if (err instanceof ToolError) {
      error = err.message
      outcome = err.outcome
      reason = err.reason
    } else {
      error = `Unexpected error: ${(err as Error).message}`
      outcome = 'backend_error'
      reason = 'unexpected'
    }
  }
  if (error === null && ctx.preview) outcome = 'preview'
  const { realm } = ctx
  const user = ctx.user !== undefined ? ctx.user : app.userOf(realm)
  try {
    const fields = logFields()
    for (const { httpStatus, outcome: lineOutcome, reason: lineReason, ...line } of Array.isArray(fields)
      ? fields
      : [fields]) {
      await app.deps.callLog({
        time: new Date().toISOString(),
        pid: app.deps.pid,
        client: app.client,
        realm,
        user,
        workspace: ctx.workspace?.id ?? null,
        tool,
        ...line,
        httpStatus: httpStatus === undefined ? ctx.state.httpStatus : httpStatus,
        outcome: lineOutcome ?? outcome,
        reason: lineOutcome === undefined ? reason : (lineReason ?? null)
      })
    }
  } catch (err) {
    app.deps.log(`colada-mcp: cannot write the call log (${(err as Error).message})`)
  }
  const notice = app.sessionNotice(realm)
  const payload = {
    realm,
    user,
    workspace: ctx.workspace,
    ...(error === null ? result : { error }),
    ...(notice === null ? {} : { notice })
  }
  return {
    content: [{ type: 'text', text: error === null && plainText !== undefined ? plainText : JSON.stringify(payload) }],
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
