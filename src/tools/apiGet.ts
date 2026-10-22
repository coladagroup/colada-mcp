import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { App } from '../app.js'
import { checkRead } from '../policy/index.js'
import { sendApiCall } from './apiCall.js'
import { apiCallOf, realmShape, runApiTool, workspaceInput } from './run.js'

export function registerApiGet(server: McpServer, app: App) {
  server.registerTool(
    'api_get',
    {
      description:
        'Sends one GET to a Colada backoffice service in one workspace, with your own roles. Returns the HTTP status, the JSON body and the headers Content-Range, ETag, X-ETag and Location. Paging: pass `Range: <unit> <start>-<end>` (end is exclusive). Bodies over 100 KB are refused: ask for less (Range, query, or a projection like /api/events:(title,start)). Services with personal data are off unless the user turned them on.',
      inputSchema: {
        ...realmShape(app),
        workspace: workspaceInput,
        service: z.string().describe('Backoffice service, for example s-events. Not s-consr-*.'),
        path: z
          .string()
          .describe(
            'Path inside the service, starting with /api/, for example /api/events/<id>. No query string here.'
          ),
        query: z
          .record(z.string(), z.string())
          .optional()
          .describe('Query parameters, for example {"q": "status=!FINISHED"}. Values are sent URL-encoded.'),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe('Only Range (paging, for example "events 0-100") and If-Match.')
      },
      annotations: { readOnlyHint: true }
    },
    (params) =>
      runApiTool(app, 'api_get', params.realm, apiCallOf({ ...params, method: 'GET' }), async (ctx) => {
        const checked = checkRead(params, app.deps.allowPersonalData)
        return sendApiCall(app, ctx, params, checked)
      })
  )
}
