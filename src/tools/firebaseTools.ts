import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { App } from '../app.js'
import type { FirebaseCall } from '../callLog.js'
import { readFirestore, readRtdb } from '../firebase/read.js'
import { realmShape, runFirebaseTool, workspaceInput } from './run.js'

const appInput = z.enum(['campaigns']).describe('Firebase app. Only "campaigns" today.')
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()])
const fieldPath = z.string().min(1).max(200)

const pathInput = (example: string) =>
  z
    .string()
    .max(768)
    .describe(
      `Path inside the workspace, without the workspace part, for example ${example}. Allowed nodes: see get_conventions "Campaigns data".`
    )

const whereInput = z
  .array(
    z.object({
      field: fieldPath.describe('Dot path inside a record, for example "date" or "content.price".'),
      op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'exists', 'missing']),
      value: z.union([scalar, z.array(scalar)]).optional()
    })
  )
  .max(10)
  .optional()
  .describe('Local filter on the records after the download. All items must match.')

export function registerRtdbGet(server: McpServer, app: App) {
  server.registerTool(
    'rtdb_get',
    {
      description:
        'Reads one node of the Campaigns Realtime Database in one workspace, with your own Campaigns permissions. Personal data and secrets are removed (removedFields lists their names). orderBy / equalTo / startAt / endAt / limitToFirst / limitToLast run in Firebase and need an index ($key always works; timesheet: owner, project; projects: account, owner, archived, guestsEventId). where / fields / groupBy / sum run in the MCP after the download; use groupBy + sum for totals instead of adding numbers yourself. Downloads over 10 MB and results over 500 KB are refused.',
      inputSchema: {
        ...realmShape(app),
        workspace: workspaceInput,
        app: appInput,
        path: pathInput('"timesheet", "projects/<id>" or "budgets/<projectId>"'),
        shallow: z.boolean().optional().describe('Only the keys of the node. Cannot be combined with other options.'),
        orderBy: z.string().max(100).optional().describe('"$key", "$value" or an indexed child name.'),
        equalTo: scalar.optional(),
        startAt: scalar.optional(),
        endAt: scalar.optional(),
        limitToFirst: z.number().int().min(1).max(10000).optional(),
        limitToLast: z.number().int().min(1).max(10000).optional(),
        where: whereInput,
        fields: z.array(fieldPath).max(30).optional().describe('Keep only these dot paths in each record.'),
        groupBy: z
          .array(fieldPath)
          .max(4)
          .optional()
          .describe(
            'Group records by fields; add ":day", ":week", ":month" or ":year" to a date field, e.g. "date:month".'
          ),
        sum: z.array(fieldPath).max(10).optional().describe('Fields to sum per group, e.g. ["hours", "minutes"].')
      },
      annotations: { readOnlyHint: true }
    },
    (params) => {
      const call: FirebaseCall = {
        app: params.app,
        store: 'rtdb',
        path: params.path,
        query: loggedQuery(params)
      }
      return runFirebaseTool(app, 'rtdb_get', params.realm, call, (ctx) => readRtdb(app, ctx, params))
    }
  )
}

export function registerFirestoreGet(server: McpServer, app: App) {
  server.registerTool(
    'firestore_get',
    {
      description:
        'Reads one document or one page of a collection of the Campaigns Firestore in one workspace, with your own Campaigns permissions. Personal data and secrets are removed (removedFields lists their names). A path with one segment is a collection, two segments are one document.',
      inputSchema: {
        ...realmShape(app),
        workspace: workspaceInput,
        app: appInput,
        path: pathInput('"serviceTickets" or "serviceTickets/<id>"'),
        pageSize: z.number().int().min(1).max(100).optional().describe('Collections only. Default 50.'),
        pageToken: z.string().max(2000).optional().describe('nextPageToken of the previous answer.'),
        fields: z.array(fieldPath).max(30).optional().describe('Return only these fields.')
      },
      annotations: { readOnlyHint: true }
    },
    (params) => {
      const call: FirebaseCall = {
        app: params.app,
        store: 'firestore',
        path: params.path,
        query: loggedQuery(params)
      }
      return runFirebaseTool(app, 'firestore_get', params.realm, call, (ctx) => readFirestore(app, ctx, params))
    }
  )
}

const LOGGED_OPTIONS = [
  'shallow',
  'orderBy',
  'equalTo',
  'startAt',
  'endAt',
  'limitToFirst',
  'limitToLast',
  'fields',
  'groupBy',
  'sum',
  'pageSize',
  'pageToken'
] as const

function loggedQuery(params: Record<string, unknown>): Record<string, unknown> {
  const query: Record<string, unknown> = {}
  for (const name of LOGGED_OPTIONS) if (params[name] !== undefined) query[name] = params[name]
  const where = params.where as Array<{ field: string; op: string }> | undefined
  if (where) query.where = where.map(({ field, op }) => ({ field, op }))
  return query
}
