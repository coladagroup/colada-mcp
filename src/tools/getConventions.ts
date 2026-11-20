import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { App } from '../app.js'
import { CONVENTIONS } from '../conventions.js'
import { runTextTool } from './run.js'

export function registerGetConventions(server: McpServer, app: App) {
  server.registerTool(
    'get_conventions',
    {
      description:
        'Returns the Colada API conventions: paging, filters, revisions and the update rules of each service. Read them before the first api_write. No login and no backend call.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    () => runTextTool(app, 'get_conventions', CONVENTIONS)
  )
}
