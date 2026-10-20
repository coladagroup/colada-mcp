import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { App } from '../app.js'
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
      runTool(app, 'logout', params, params.realm ?? null, async (ctx) => {
        const realms = params.realm ? [params.realm] : app.availableRealms()
        let user: string | null = null
        for (const realm of realms) {
          user = (await app.realm(realm).session.logout()) ?? user
        }
        ctx.user = user
        return { message: params.realm ? `Logged out from ${params.realm}.` : 'Logged out from all realms.' }
      })
  )
}
