import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { App } from './app.js'
import { CONVENTIONS, CONVENTIONS_URI, INSTRUCTIONS } from './conventions.js'
import { registerApiGet } from './tools/apiGet.js'
import { registerApiWrite } from './tools/apiWrite.js'
import { registerBudgetTools } from './tools/budgetTools.js'
import { registerCampaignsBudget, registerFirestoreGet, registerRtdbGet } from './tools/firebaseTools.js'
import { registerGetApiDoc } from './tools/getApiDoc.js'
import { registerGetConventions } from './tools/getConventions.js'
import { registerListWorkspaces } from './tools/listWorkspaces.js'
import { registerLogout } from './tools/logout.js'
import { registerOfferTools } from './tools/offerTools.js'
import { registerTimesheetTools } from './tools/timesheetTools.js'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export function createServer(app: App): McpServer {
  const server = new McpServer({ name: 'colada-mcp', version }, { instructions: INSTRUCTIONS })
  server.registerResource(
    'conventions',
    CONVENTIONS_URI,
    { title: 'Colada API conventions', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: CONVENTIONS }] })
  )
  registerListWorkspaces(server, app)
  registerGetConventions(server)
  registerGetApiDoc(server, app)
  registerApiGet(server, app)
  registerApiWrite(server, app)
  registerRtdbGet(server, app)
  registerFirestoreGet(server, app)
  registerCampaignsBudget(server, app)
  registerTimesheetTools(server, app)
  registerOfferTools(server, app)
  registerBudgetTools(server, app)
  registerLogout(server, app)
  return server
}
