import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { callBackend } from '../api/backend.js'
import type { App } from '../app.js'
import { checkEventId } from './ids.js'
import { realmInput, runTool, workspaceInput } from './run.js'

export function registerGetRegistrationForm(server: McpServer, app: App) {
  server.registerTool(
    'get_registration_form',
    {
      description: 'Returns the registration form of an event as the raw backoffice JSON.',
      inputSchema: { realm: realmInput, workspace: workspaceInput, eventId: z.string().describe('Event id') },
      annotations: { readOnlyHint: true }
    },
    (params) => {
      const realm = params.realm || 'default'
      return runTool(app, 'get_registration_form', params, realm, async (ctx) => {
        const { session, directory } = app.realm(realm)
        checkEventId(params.eventId)
        const workspace = await directory.resolve(params.workspace, ctx.state)
        ctx.workspace = workspace
        const response = await callBackend(
          app.api,
          session,
          {
            workspaceId: workspace.id,
            path: `/_gw/s-events-forms/api/events/${params.eventId}/formtemplates/registration`,
            notFound: `Event ${params.eventId} has no registration form in workspace ${workspace.id}, or the event does not exist.`
          },
          ctx.state
        )
        return { form: response.body }
      })
    }
  )
}
