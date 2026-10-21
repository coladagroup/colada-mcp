import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { App } from '../app.js'
import { messages, ToolError } from '../errors.js'
import { realmInput, runTool } from './run.js'

export function registerLogout(server: McpServer, app: App) {
  server.registerTool(
    'logout',
    {
      description:
        'Ends the stored Colada session of one realm, or of all realms when no realm is given. The next tool call opens the browser login again.',
      inputSchema: {
        realm: realmInput.describe('Realm to log out from. Leave it out to log out from all realms.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    (params) =>
      runTool(app, 'logout', params, params.realm || null, async (ctx) => {
        const realms = params.realm ? [params.realm] : app.availableRealms()
        let user: string | null = null
        const failed: string[] = []
        for (const realm of realms) {
          const { session } = app.realm(realm)
          try {
            user = (await session.logout()) ?? user
          } catch {
            failed.push(realm)
          }
        }
        ctx.user = user
        if (failed.length > 0) throw new ToolError(messages.logoutFailed(failed))
        return { message: params.realm ? `Logged out from ${params.realm}.` : 'Logged out from all realms.' }
      })
  )
}
