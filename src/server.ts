import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { App } from './app.js'
import { registerGetEmailTemplate } from './tools/getEmailTemplate.js'
import { registerGetEvent } from './tools/getEvent.js'
import { registerGetRegistrationForm } from './tools/getRegistrationForm.js'
import { registerListEmailTemplates } from './tools/listEmailTemplates.js'
import { registerListEvents } from './tools/listEvents.js'
import { registerListWorkspaces } from './tools/listWorkspaces.js'
import { registerLogout } from './tools/logout.js'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export function createServer(app: App): McpServer {
  const server = new McpServer({ name: 'colada-mcp', version })
  registerListWorkspaces(server, app)
  registerListEvents(server, app)
  registerGetEvent(server, app)
  registerListEmailTemplates(server, app)
  registerGetEmailTemplate(server, app)
  registerGetRegistrationForm(server, app)
  registerLogout(server, app)
  return server
}
