import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { callBackend } from '../api/backend.js'
import type { App } from '../app.js'
import { checkUuid } from './ids.js'
import { realmInput, runTool, workspaceInput } from './run.js'

export function registerGetEmailTemplate(server: McpServer, app: App) {
  server.registerTool(
    'get_email_template',
    {
      description: 'Returns one email template of an event, with subject and body, as the raw backoffice JSON.',
      inputSchema: {
        realm: realmInput,
        workspace: workspaceInput,
        eventId: z.string().describe('Event id'),
        templateId: z.string().describe('Email template id from list_email_templates')
      },
      annotations: { readOnlyHint: true }
    },
    (params) => {
      const realm = params.realm || 'default'
      return runTool(app, 'get_email_template', params, realm, async (ctx) => {
        const { session, directory } = app.realm(realm)
        checkUuid('eventId', params.eventId)
        checkUuid('templateId', params.templateId)
        const workspace = await directory.resolve(params.workspace, ctx.state)
        ctx.workspace = workspace
        const response = await callBackend(
          app.api,
          session,
          {
            workspaceId: workspace.id,
            path: `/_gw/s-email-templates/api/events/${params.eventId}/emailtemplates/${params.templateId}`,
            notFound: `Email template ${params.templateId} of event ${params.eventId} not found in workspace ${workspace.id}. The event may not exist either.`
          },
          ctx.state
        )
        return { template: response.body }
      })
    }
  )
}
