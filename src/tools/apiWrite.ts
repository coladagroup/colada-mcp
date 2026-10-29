import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { App } from '../app.js'
import { checkWrite } from '../policy/index.js'
import { checkWithMarkers, sendApiCall } from './apiCall.js'
import { apiCallOf, realmShape, runApiTool, workspaceInput } from './run.js'

export function registerApiWrite(server: McpServer, app: App) {
  server.registerTool(
    'api_write',
    {
      description:
        'Changes data in a Colada backoffice service: POST, PUT or PATCH with a JSON body (DELETE only for the few allowlisted routes, such as unpublishing a registration form), in one workspace, with your own roles. The user approves each call. Read the object with api_get first and pass its X-ETag value as If-Match. Routes that delete data are blocked; deleting data stays a manual backoffice action. Returns the status, the JSON body and the headers Content-Range, ETag, X-ETag and Location.',
      inputSchema: {
        ...realmShape(app),
        workspace: workspaceInput,
        method: z.string().describe('POST, PUT or PATCH; DELETE only on allowlisted routes.'),
        service: z.string(),
        path: z.string(),
        query: z.record(z.string(), z.string()).optional(),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Only Range and If-Match. For an update, pass If-Match with the X-ETag of your last api_get of the object.'
          ),
        body: z.unknown().optional().describe('JSON request body.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    },
    (params) =>
      runApiTool(app, 'api_write', params.realm, apiCallOf(params), async (ctx) => {
        const checked = await checkWithMarkers(app, ctx, params, (allow, markers) =>
          checkWrite(params.method, params, allow, markers)
        )
        return sendApiCall(app, ctx, params, checked)
      })
  )
}
