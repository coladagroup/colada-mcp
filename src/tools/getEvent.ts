import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { callBackend } from '../api/backend.js'
import type { App } from '../app.js'
import { checkEventId } from './ids.js'
import { realmInput, runTool, workspaceInput } from './run.js'

export function registerGetEvent(server: McpServer, app: App) {
  server.registerTool(
    'get_event',
    {
      description: 'Returns one event of a workspace as the raw backoffice JSON.',
      inputSchema: { realm: realmInput, workspace: workspaceInput, eventId: z.string().describe('Event id') },
      annotations: { readOnlyHint: true }
    },
    (params) => {
      const realm = params.realm || 'default'
      return runTool(app, 'get_event', params, realm, async (ctx) => {
        const { session, directory } = app.realm(realm)
        checkEventId(params.eventId)
        const workspace = await directory.resolve(params.workspace, ctx.state)
        ctx.workspace = workspace
        const response = await callBackend(
          app.api,
          session,
          {
            workspaceId: workspace.id,
            path: `/_gw/s-events/api/events/${params.eventId}`,
            notFound: `Event ${params.eventId} not found in workspace ${workspace.id}.`
          },
          ctx.state
        )
        return { event: response.body }
      })
    }
  )
}
