import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { MAX_WRITES_PER_MINUTE } from '../api/client.js'
import type { App } from '../app.js'
import { applyEdits, checkEditPaths } from '../dotPath.js'
import { fail, ToolError } from '../errors.js'
import { checkRead, checkWrite, MAX_GET_DOWNLOAD_BYTES, requiresIfMatch } from '../policy/index.js'
import { plannedRequest, sendApiCall } from './apiCall.js'
import { type BatchLine, openRealm, previewInput, realmShape, runApiBatchTool, workspaceInput } from './run.js'

const UPDATE_PREVIEW_NOTE =
  'Preview: only the GET was sent; no write budget was used. Call api_update again without preview to send the write.'
const NO_CHANGE_NOTE = 'The record already has these values. Nothing was written.'

const dotPath = z.string().min(1).max(200)

export function registerApiUpdate(server: McpServer, app: App) {
  server.registerTool(
    'api_update',
    {
      description:
        'Changes a few fields of one record in a Colada backoffice service without sending the whole record yourself. It sends GET to getPath (default: path), applies remove and then set to the record, and sends the full record with PATCH or PUT to path, with If-Match set to the X-ETag (else ETag) of the GET. Paths are in dot form and refer to the record as read; a number is an array index (for example "properties.3"). set creates missing object fields but never adds array items. A 409 or 412 means somebody changed the record: read it again, nothing is retried. The answer has the status, revisionChecked and only the changed paths with old and new values, not the record. With preview: true the GET runs and the write is not sent. The GET and the write have the same checks as api_get and api_write. The user approves each call. No batch form: for a series, call it once per record.',
      inputSchema: {
        ...realmShape(app),
        workspace: workspaceInput,
        method: z.enum(['PATCH', 'PUT']),
        service: z.string(),
        path: z.string().describe('Path of the write, starting with /api/.'),
        getPath: z.string().optional().describe('Path of the GET when it differs from path.'),
        query: z.record(z.string(), z.string()).optional().describe('Query parameters of the write only.'),
        set: z.record(dotPath, z.unknown()).optional().describe('Dot path → new value.'),
        remove: z.array(dotPath).max(100).optional().describe('Dot paths to remove.'),
        preview: previewInput
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    },
    (params) => {
      const getPath = params.getPath ?? params.path
      const lines = [
        { method: 'GET', service: params.service, path: getPath, query: {}, ifMatch: false },
        { method: params.method, service: params.service, path: params.path, query: params.query ?? {}, ifMatch: false }
      ]
      return runApiBatchTool(app, 'api_update', params.realm, lines, async (ctx) => {
        const [getLine, writeLine] = ctx.lines as [BatchLine, BatchLine]
        const set = params.set ?? {}
        const remove = params.remove ?? []
        if (Object.keys(set).length === 0 && remove.length === 0) throw fail.updateNoChange()
        checkEditPaths(set, remove)
        const getChecked = checkRead({ service: params.service, path: getPath }, app.deps.allowPersonalData)
        checkWrite(params.method, params, app.deps.allowPersonalData)
        const ifMatchRequired = requiresIfMatch(params.method, params)
        if (params.preview !== true && app.api.remainingWrites() < 1) {
          throw fail.writeBudget(params.method, `/_gw/${params.service}${params.path}`, MAX_WRITES_PER_MINUTE)
        }

        const target = { realm: params.realm, workspace: params.workspace, service: params.service }
        let read: Awaited<ReturnType<typeof sendApiCall>>
        try {
          read = await sendApiCall(app, ctx, { ...target, path: getPath }, getChecked, MAX_GET_DOWNLOAD_BYTES)
        } catch (err) {
          if (err instanceof ToolError) Object.assign(getLine, { outcome: err.outcome, reason: err.reason })
          Object.assign(getLine, { httpStatus: ctx.state.httpStatus })
          Object.assign(writeLine, { outcome: 'refused', reason: 'notRun' })
          throw err
        }
        Object.assign(getLine, { httpStatus: read.status, outcome: 'ok', reason: null })
        ctx.state = { httpStatus: null }

        const revision = revisionOf(read.headers)
        const { record, changes } = applyEdits(read.body, set, remove)
        if (revision === null && ifMatchRequired) throw fail.updateNoRevision(params.method, params.path)
        const revisionChecked = revision !== null
        writeLine.ifMatch = revisionChecked
        const writeChecked = checkWrite(
          params.method,
          { ...params, headers: revisionChecked ? { 'If-Match': revision } : {} },
          app.deps.allowPersonalData
        )
        if (changes.length === 0) {
          Object.assign(writeLine, { outcome: 'ok', reason: 'noChange' })
          return { status: null, revisionChecked, changed: [], note: NO_CHANGE_NOTE }
        }
        if (params.preview === true) {
          ctx.preview = true
          const { session } = await openRealm(app, ctx, params.realm)
          const { body: _body, ...request } = plannedRequest(session.host, { ...target, ...params }, writeChecked)
          return { preview: true, note: UPDATE_PREVIEW_NOTE, request, revisionChecked, changed: changes }
        }

        let written: Awaited<ReturnType<typeof sendApiCall>>
        try {
          written = await sendApiCall(
            app,
            ctx,
            { ...target, path: params.path, query: params.query, body: record },
            writeChecked
          )
        } finally {
          writeLine.httpStatus = ctx.state.httpStatus
        }
        return {
          status: written.status,
          headers: written.headers,
          revisionChecked,
          ...(revisionChecked ? {} : { note: 'no revision check: the GET returned no X-ETag or ETag.' }),
          changed: changes
        }
      })
    }
  )
}

function revisionOf(headers: Record<string, string>): string | null {
  const value = headers['X-ETag'] ?? headers.ETag
  return value === undefined || value === '' || value === '0' ? null : value
}
