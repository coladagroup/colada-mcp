import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { App } from '../app.js'
import { openRealm, realmShape, runTool } from './run.js'

export function registerListWorkspaces(server: McpServer, app: App) {
  server.registerTool(
    'list_workspaces',
    {
      description: app.multiRealm
        ? 'Lists the Colada workspaces you can open in one realm (default: the main realm). Another realm needs its own browser login. Pass the workspace id or exact name, and the same realm, to the other tools.'
        : 'Lists the Colada workspaces you can open. Pass the workspace id or exact name to the other tools.',
      inputSchema: realmShape(app),
      annotations: { readOnlyHint: true }
    },
    (params) => {
      return runTool(app, 'list_workspaces', params, async (ctx) => {
        const { directory } = await openRealm(app, ctx, params.realm)
        return { workspaces: await directory.list(ctx.state, true) }
      })
    }
  )
}
