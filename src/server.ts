import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { App } from './app.js'
import { CONVENTIONS, CONVENTIONS_URI, INSTRUCTIONS } from './conventions.js'
import { registerApiGet } from './tools/apiGet.js'
import { registerApiWrite } from './tools/apiWrite.js'
import { registerApiWriteBatch } from './tools/apiWriteBatch.js'
import { registerBudgetTools } from './tools/budgetTools.js'
import {
  registerCampaignsBudget,
  registerFirestoreGet,
  registerKbSearch,
  registerRtdbGet
} from './tools/firebaseTools.js'
import { registerGetApiDoc } from './tools/getApiDoc.js'
import { registerGetConventions } from './tools/getConventions.js'
import { registerListWorkspaces } from './tools/listWorkspaces.js'
import { registerLogout } from './tools/logout.js'
import { registerOfferTools } from './tools/offerTools.js'
import { registerTimesheetTools } from './tools/timesheetTools.js'
import { version } from './version.js'

export function createServer(app: App): McpServer {
  const server = new McpServer({ name: 'colada-mcp', version }, { instructions: INSTRUCTIONS })
  server.server.oninitialized = () => {
    app.client = server.server.getClientVersion()?.name ?? null
  }
  server.registerResource(
    'conventions',
    CONVENTIONS_URI,
    { title: 'Colada API conventions', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: CONVENTIONS }] })
  )
  registerListWorkspaces(server, app)
  registerGetConventions(server, app)
  registerGetApiDoc(server, app)
  registerApiGet(server, app)
  registerApiWrite(server, app)
  registerApiWriteBatch(server, app)
  registerRtdbGet(server, app)
  registerFirestoreGet(server, app)
  registerCampaignsBudget(server, app)
  registerKbSearch(server, app)
  registerTimesheetTools(server, app)
  registerOfferTools(server, app)
  registerBudgetTools(server, app)
  registerLogout(server, app)
  return server
}
