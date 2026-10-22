import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { App } from './app.js'
import { registerApiGet } from './tools/apiGet.js'
import { registerApiWrite } from './tools/apiWrite.js'
import { registerGetApiDoc } from './tools/getApiDoc.js'
import { registerListWorkspaces } from './tools/listWorkspaces.js'
import { registerLogout } from './tools/logout.js'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export function createServer(app: App): McpServer {
  const server = new McpServer({ name: 'colada-mcp', version })
  registerListWorkspaces(server, app)
  registerGetApiDoc(server, app)
  registerApiGet(server, app)
  registerApiWrite(server, app)
  registerLogout(server, app)
  return server
}
