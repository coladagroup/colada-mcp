import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { App } from '../app.js'
import { realmInput, runTool } from './run.js'

export function registerListWorkspaces(server: McpServer, app: App) {
  server.registerTool(
    'list_workspaces',
    {
      description:
        'Lists the Colada workspaces you can open in one realm (default: default; also vw, abiomed, lidl — each needs its own login). Pass the workspace id or exact name, and the same realm, to the other tools.',
      inputSchema: { realm: realmInput },
      annotations: { readOnlyHint: true }
    },
    (params) => {
      const realm = params.realm ?? 'default'
      return runTool(app, 'list_workspaces', params, realm, async (ctx) => {
        const { directory } = app.realm(realm)
        return { workspaces: await directory.list(ctx.state, true) }
      })
    }
  )
}
