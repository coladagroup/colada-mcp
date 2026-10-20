import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { App } from './app.js'
import { registerGetEvent } from './tools/getEvent.js'
import { registerListWorkspaces } from './tools/listWorkspaces.js'
import { registerLogout } from './tools/logout.js'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export function createServer(app: App): McpServer {
  const server = new McpServer({ name: 'colada-mcp', version })
  registerListWorkspaces(server, app)
  registerGetEvent(server, app)
  registerLogout(server, app)
  return server
}
