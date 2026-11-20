import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { App } from '../app.js'
import { pushKey } from '../firebase/campaigns/writes/pushKey.js'
import {
  ADD_TIMESHEET,
  addTimesheetReport,
  UPDATE_TIMESHEET,
  updateTimesheetReport
} from '../firebase/campaigns/writes/timesheetReports.js'
import {
  previewShape,
  realmShape,
  runFirebaseWriteTool,
  WRITE_TOOL_ANNOTATIONS,
  withoutPreview,
  workspaceInput,
  writeInput
} from './run.js'

const id = (what: string) => z.string().min(1).max(200).describe(what)

const fields = {
  date: z.string().describe('Day of the work, yyyy-MM-dd. Not in the future.'),
  hours: z.number().min(0).optional().describe('Default 0.'),
  minutes: z.number().min(0).optional().describe('Default 0.'),
  project: id('A key of projects, or a Firestore serviceTickets id.'),
  entity: z
    .string()
    .max(200)
    .optional()
    .describe('Uid of a budget row in budgets/<project>. Not for a service ticket.'),
  account: z.string().max(200).optional().describe('Directory account id.'),
  tag: z.string().max(200).optional().describe('A key of tags.'),
  description: z.string().max(10000).optional().describe('Personal data: needs COLADA_ALLOW_PERSONAL_DATA=true.')
}

const WRITTEN_NOTE =
  'The output lists every write in "written". There is no undo. Call with preview: true first to see the writes without sending them and check them with the user; on prod hosts the real call needs the previewId from that preview.'

export function registerTimesheetTools(server: McpServer, app: App) {
  server.registerTool(
    ADD_TIMESHEET,
    {
      description: `Adds one entry to your own Campaigns timesheet in one workspace, as the Timesheet page does. With "entity" the entry is also copied into reports[date] of that row in budgets/<project>. The Timesheet page counts an entry only when it has "account" and "description" (it shows a red "!" otherwise), so pass both. owner is always you. ${WRITTEN_NOTE}`,
      inputSchema: writeInput({ ...realmShape(app), workspace: workspaceInput, ...previewShape, ...fields }),
      annotations: WRITE_TOOL_ANNOTATIONS
    },
    (params) => {
      const key = pushKey(app.deps.now() * 1000)
      return runFirebaseWriteTool(app, ADD_TIMESHEET, params, null, (ctx) =>
        addTimesheetReport(app, ctx, withoutPreview(params), key)
      )
    }
  )
  server.registerTool(
    UPDATE_TIMESHEET,
    {
      description: `Changes one of your own Campaigns timesheet entries. A change of project, entity or date moves the budget copy: added to the new row first, then removed from the old one. When project changes and entity is not given, entity is cleared; entity "" clears it. ${WRITTEN_NOTE}`,
      inputSchema: writeInput({
        ...realmShape(app),
        workspace: workspaceInput,
        ...previewShape,
        key: id('Key of your timesheet entry.'),
        date: fields.date.optional(),
        hours: fields.hours,
        minutes: fields.minutes,
        project: fields.project.optional(),
        entity: fields.entity,
        account: fields.account,
        tag: fields.tag,
        description: fields.description
      }),
      annotations: WRITE_TOOL_ANNOTATIONS
    },
    (params) => {
      return runFirebaseWriteTool(app, UPDATE_TIMESHEET, params, `timesheet/${params.key}`, (ctx) =>
        updateTimesheetReport(app, ctx, withoutPreview(params))
      )
    }
  )
}
