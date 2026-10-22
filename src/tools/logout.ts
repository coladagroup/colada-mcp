import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { App } from '../app.js'
import { messages, ToolError } from '../errors.js'
import { openRealm, realmShape, runTool } from './run.js'

export function registerLogout(server: McpServer, app: App) {
  const realmParam = realmShape(app).realm
  server.registerTool(
    'logout',
    {
      description: app.multiRealm
        ? 'Ends the stored Colada session of one realm, or of all realms when no realm is given. The next tool call opens the browser login again.'
        : 'Ends the stored Colada session. The next tool call opens the browser login again.',
      inputSchema: realmParam
        ? { realm: realmParam.describe('Realm to log out from. Leave it out to log out from all realms.') }
        : {},
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    (params: { realm?: string }) =>
      runTool(app, 'logout', params, async (ctx) => {
        const single = Boolean(params.realm) || !app.multiRealm
        const contexts = single ? [await openRealm(app, ctx, params.realm)] : await app.allRealms()
        let user: string | null = null
        const failed: string[] = []
        for (const { session } of contexts) {
          try {
            user = (await session.logout()) ?? user
          } catch {
            failed.push(session.realm)
          }
        }
        ctx.user = user
        if (failed.length > 0) throw new ToolError(messages.logoutFailed(failed))
        return { message: single ? `Logged out from ${ctx.realm}.` : 'Logged out from all realms.' }
      })
  )
}
