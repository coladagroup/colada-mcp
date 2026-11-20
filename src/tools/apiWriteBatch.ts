import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { MAX_WRITES_PER_MINUTE } from '../api/client.js'
import type { App } from '../app.js'
import { fail, messages, ToolError } from '../errors.js'
import { type CheckedRequest, checkWrite } from '../policy/index.js'
import { plannedRequest, sendApiCall } from './apiCall.js'
import { apiCallOf, openRealm, previewInput, realmShape, runApiBatchTool, workspaceInput } from './run.js'

export const MAX_BATCH_ITEMS = 25

const BATCH_PREVIEW_NOTE =
  'Preview: nothing was sent and no write budget was used. Call api_write_batch again without preview to send the items.'

const item = z.strictObject({
  method: z.string().describe('POST, PUT or PATCH; DELETE only on allowlisted routes.'),
  service: z.string(),
  path: z.string(),
  query: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional().describe('Only Range and If-Match.'),
  body: z.unknown().optional().describe('JSON request body.')
})

type Item = z.infer<typeof item>

export function registerApiWriteBatch(server: McpServer, app: App) {
  server.registerTool(
    'api_write_batch',
    {
      description: `Sends 1 to ${MAX_BATCH_ITEMS} writes of api_write in one workspace, in order, one at a time; the user approves the whole batch once. Use it for a bulk change after the same change worked with api_write on one record. Every item is checked first: if one item is refused, nothing is sent. The batch stops at the first item that fails; the answer lists each item as done (HTTP status and the headers ETag, X-ETag, Location), failed (status and error) or not run. Response bodies are not returned: read the records with api_get. Each item counts against the 60 writes per minute; a batch that does not fit is refused before the first request. With preview: true it returns the checked requests without sending them.`,
      inputSchema: {
        ...realmShape(app),
        workspace: workspaceInput,
        items: z.array(item).min(1).max(MAX_BATCH_ITEMS),
        preview: previewInput
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    },
    (params) =>
      runApiBatchTool(app, 'api_write_batch', params.realm, params.items.map(apiCallOf), async (ctx) => {
        if (params.preview === true) {
          ctx.preview = true
          const { session, directory } = await openRealm(app, ctx, params.realm)
          ctx.workspace = await directory.resolve(params.workspace, { httpStatus: null })
          const items = params.items.map((entry, index) => {
            try {
              const checked = checkWrite(entry.method, entry, app.deps.allowPersonalData)
              return { item: index + 1, request: plannedRequest(session.host, entry, checked) }
            } catch (err) {
              if (!(err instanceof ToolError)) throw err
              Object.assign(ctx.lines[index] ?? {}, { outcome: err.outcome, reason: err.reason })
              return { item: index + 1, refused: err.message }
            }
          })
          return { preview: true, note: BATCH_PREVIEW_NOTE, items }
        }

        const checked = params.items.map((entry, index) => checkItem(app, entry, index))
        const { directory } = await openRealm(app, ctx, params.realm)
        ctx.workspace = await directory.resolve(params.workspace, ctx.state)
        const remaining = app.api.remainingWrites()
        if (checked.length > remaining) throw fail.batchBudget(checked.length, remaining, MAX_WRITES_PER_MINUTE)

        const results: Array<Record<string, unknown>> = []
        let stopped = false
        for (const [index, entry] of params.items.entries()) {
          const line = ctx.lines[index]
          if (line === undefined) continue
          if (stopped) {
            Object.assign(line, { outcome: 'refused', reason: 'notRun' })
            results.push({ item: index + 1, result: 'not run' })
            continue
          }
          const itemCtx = { realm: ctx.realm, state: { httpStatus: null }, workspace: null }
          try {
            const response = await sendApiCall(
              app,
              itemCtx,
              { ...entry, realm: params.realm, workspace: params.workspace },
              checked[index] as CheckedRequest
            )
            Object.assign(line, { httpStatus: response.status, outcome: 'ok', reason: null })
            results.push({ item: index + 1, result: 'done', status: response.status, headers: response.headers })
          } catch (err) {
            const error = err instanceof ToolError ? err : new ToolError(`Unexpected error: ${(err as Error).message}`)
            const reason = err instanceof ToolError ? err.reason : 'unexpected'
            Object.assign(line, { httpStatus: itemCtx.state.httpStatus, outcome: error.outcome, reason })
            results.push({ item: index + 1, result: 'failed', status: itemCtx.state.httpStatus, error: error.message })
            stopped = true
          } finally {
            ctx.realm = itemCtx.realm
            ctx.workspace = itemCtx.workspace ?? ctx.workspace
          }
        }
        return { done: results.filter((result) => result.result === 'done').length, items: results }
      })
  )
}

function checkItem(app: App, entry: Item, index: number): CheckedRequest {
  try {
    return checkWrite(entry.method, entry, app.deps.allowPersonalData)
  } catch (err) {
    if (!(err instanceof ToolError)) throw err
    throw new ToolError(messages.batchItemRefused(index + 1, err.message), err.outcome, err.reason)
  }
}
