import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { App } from '../app.js'
import { messages, ResponseTooLargeError } from '../errors.js'
import { checkRead, MAX_GET_DOWNLOAD_BYTES, MAX_RESPONSE_BYTES } from '../policy/index.js'
import { selectInput, selectPaths } from '../select.js'
import { sendApiCall } from './apiCall.js'
import { apiCallOf, realmShape, runApiTool, workspaceInput } from './run.js'

export function registerApiGet(server: McpServer, app: App) {
  server.registerTool(
    'api_get',
    {
      description:
        'Sends one GET to a Colada backoffice service in one workspace, with your own roles. Returns the HTTP status, the JSON body and the headers Content-Range, ETag, X-ETag and Location. Paging: pass `Range: <unit> <start>-<end>` (end is exclusive: `events 0-10` returns 10 items, the next page is `events 10-20`; never send the same start and end). Answers over 500 KB are refused: ask for less with select (keeps only the paths you name), Range, query, or a projection like /api/events:(title,start). Downloads over 10 MB are refused. Services with personal data are off unless the user turned them on.',
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
          .describe('Only Range (paging, for example "events 0-100") and If-Match.'),
        select: selectInput
      },
      annotations: { readOnlyHint: true }
    },
    (params) =>
      runApiTool(app, 'api_get', params.realm, apiCallOf({ ...params, method: 'GET' }), async (ctx) => {
        const checked = checkRead(params, app.deps.allowPersonalData)
        const maxBytes = params.select === undefined ? undefined : MAX_GET_DOWNLOAD_BYTES
        const response = await sendApiCall(app, ctx, params, checked, maxBytes)
        const answer =
          params.select === undefined
            ? response
            : { ...response, body: selectPaths(response.body, params.select), selected: params.select }
        if (Buffer.byteLength(JSON.stringify(answer)) > MAX_RESPONSE_BYTES) {
          throw new ResponseTooLargeError(messages.tooLarge('GET', `/_gw/${params.service}${params.path}`))
        }
        return answer
      })
  )
}
