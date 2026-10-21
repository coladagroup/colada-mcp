import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { fetchPage, PAGE_SIZE } from '../api/paging.js'
import type { App } from '../app.js'
import { checkEventId } from './ids.js'
import { realmInput, runTool, workspaceInput } from './run.js'

type TemplateItem = Record<string, unknown>

function toItem(template: TemplateItem) {
  return {
    id: template.id ?? null,
    name: template.name ?? null,
    displayName: template.displayName ?? null,
    from: template.from ?? null,
    to: template.to ?? null,
    ...(template.sendingCondition === undefined ? {} : { sendingCondition: template.sendingCondition }),
    createdAt: template.createdAt ?? null,
    updatedAt: template.updatedAt ?? null
  }
}

export function registerListEmailTemplates(server: McpServer, app: App) {
  server.registerTool(
    'list_email_templates',
    {
      description:
        'Lists all email templates of one event, without subject or body. Use get_email_template for the full template.',
      inputSchema: { realm: realmInput, workspace: workspaceInput, eventId: z.string().describe('Event id') },
      annotations: { readOnlyHint: true }
    },
    (params) => {
      const realm = params.realm || 'default'
      return runTool(app, 'list_email_templates', params, realm, async (ctx) => {
        const { session, directory } = app.realm(realm)
        checkEventId(params.eventId)
        const workspace = await directory.resolve(params.workspace, ctx.state)
        ctx.workspace = workspace
        const request = {
          workspaceId: workspace.id,
          path: `/_gw/s-email-templates/api/events/${params.eventId}/emailtemplates/all`,
          query: `sort=${encodeURIComponent('createdAt:asc')}`
        }
        const items: TemplateItem[] = []
        let total = 0
        for (let start = 0; start === 0 || start < total; start += PAGE_SIZE) {
          const page = await fetchPage(app.api, session, request, 'emailtemplates', start, ctx.state)
          total = page.total
          items.push(...(page.items as TemplateItem[]))
        }
        return { eventId: params.eventId, total, items: items.map(toItem) }
      })
    }
  )
}
