import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type App, isoTime } from '../app.js'
import { version } from '../version.js'
import { openRealm, realmShape, runTool } from './run.js'

function sessionNote(endsAt: string): string {
  return `This Colada session ends at ${endsAt} because it reuses your browser sign-in (10 h limit). For a full 10 h: sign out of the backoffice in the browser, call logout, then sign in again.`
}

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
        const { directory, session } = await openRealm(app, ctx, params.realm)
        const workspaces = await directory.list(ctx.state, true)
        const endsAt = await session.sessionEndsAt()
        const shortEndsAt = session.shortSessionEndsAt()
        return {
          version,
          workspaces,
          sessionEndsAt: endsAt === null ? null : isoTime(endsAt),
          ...(shortEndsAt === null ? {} : { sessionNote: sessionNote(isoTime(shortEndsAt)) })
        }
      })
    }
  )
}
