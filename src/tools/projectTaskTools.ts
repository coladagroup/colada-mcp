import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { App } from '../app.js'
import { PROJECT_STATUSES, PROJECT_TYPES, UPDATE_PROJECT, updateProject } from '../firebase/campaigns/writes/project.js'
import { pushKey } from '../firebase/campaigns/writes/pushKey.js'
import {
  CREATE_TASK,
  createTask,
  TASK_PRIORITIES,
  UPDATE_TASK,
  updateTask
} from '../firebase/campaigns/writes/tasks.js'
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
const PERSONAL = 'Personal data: needs COLADA_ALLOW_PERSONAL_DATA=true.'
const WRITTEN_NOTE =
  'The output lists every write in "written". There is no undo. Call with preview: true first to see the writes without sending them and check them with the user; on prod hosts the real call needs the previewId from that preview.'
const NO_NOTIFICATION =
  'The MCP writes the task only: no notification, no email and no files, so assignees and mentioned users are not told. Tell them yourself if they need to know.'

const source = id('Key of the task boards in taskBoards: the uid of the project, offer or lead.')
const board = (fallback: string) =>
  z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(`Board id from taskBoards/<source>/boards, for example backlog, progress or finished. ${fallback}`)
const taskFields = {
  summary: z.string().max(20000).optional().describe(`Description, as HTML like the app editor. ${PERSONAL}`),
  dueDate: z
    .union([z.iso.date(), z.literal('')])
    .optional()
    .describe('Due date yyyy-MM-dd. "" clears it.'),
  priority: z.enum(TASK_PRIORITIES).optional(),
  assignees: z
    .array(z.string().min(1).max(320))
    .max(50)
    .optional()
    .describe(`User uids or emails of Campaigns users of the workspace. Stored as uids. [] clears them. ${PERSONAL}`)
}

export function registerProjectTaskTools(server: McpServer, app: App) {
  server.registerTool(
    UPDATE_PROJECT,
    {
      description: `Sets the status and/or type of one Campaigns project (projects/<id>), as the project Settings dialog does. Only status, type and updatedAt are written; nothing else of the project can change with this tool. "" means none. A status of toBeInvoiced shows the project in the finance dashboard and the global budget. Archived projects cannot be changed. ${WRITTEN_NOTE}`,
      inputSchema: writeInput({
        ...realmShape(app),
        workspace: workspaceInput,
        ...previewShape,
        project: id('Key of the project in projects.'),
        status: z.enum([...PROJECT_STATUSES, '']).optional(),
        type: z.enum([...PROJECT_TYPES, '']).optional()
      }),
      annotations: WRITE_TOOL_ANNOTATIONS
    },
    (params) =>
      runFirebaseWriteTool(app, UPDATE_PROJECT, params, `projects/${params.project}`, (ctx) =>
        updateProject(app, ctx, withoutPreview(params))
      )
  )
  server.registerTool(
    CREATE_TASK,
    {
      description: `Creates a task on the task boards of a Campaigns project, offer or lead, as the app's new-task dialog does: the next task number with the board prefix, at the end of the board, owner you, priority low unless given. With "invoice" the task is linked to that invoice of the project and the invoice's task count goes up by one. ${NO_NOTIFICATION} ${WRITTEN_NOTE}`,
      inputSchema: writeInput({
        ...realmShape(app),
        workspace: workspaceInput,
        ...previewShape,
        source,
        board: board('Default backlog. Not archived.'),
        name: z.string().min(1).max(500).describe('Task title.'),
        ...taskFields,
        invoice: id('Uid of an invoice in invoices/<source> to link the task to.').optional()
      }),
      annotations: WRITE_TOOL_ANNOTATIONS
    },
    (params) => {
      const fresh = { uid: randomUUID(), externalId: pushKey(app.deps.now() * 1000) }
      return runFirebaseWriteTool(app, CREATE_TASK, params, `taskBoards/${params.source}`, (ctx) =>
        createTask(app, ctx, withoutPreview(params), fresh)
      )
    }
  )
  server.registerTool(
    UPDATE_TASK,
    {
      description: `Changes one task on the task boards of a Campaigns project, offer or lead, as the app's task dialog does: title, description, due date, priority, assignees and the board (the status). Only the given fields change, plus updatedAt and updatedBy. A board change moves the task to the end of that board; a final board (finished) sets finishedAt and finishedBy. Archived tasks cannot be changed, and the tool never archives or deletes a task. ${NO_NOTIFICATION} ${WRITTEN_NOTE}`,
      inputSchema: writeInput({
        ...realmShape(app),
        workspace: workspaceInput,
        ...previewShape,
        source,
        task: id('Uid of the task.'),
        board: board('Not archived.'),
        name: z.string().min(1).max(500).optional().describe('Task title.'),
        ...taskFields
      }),
      annotations: WRITE_TOOL_ANNOTATIONS
    },
    (params) =>
      runFirebaseWriteTool(app, UPDATE_TASK, params, `taskBoards/${params.source}`, (ctx) =>
        updateTask(app, ctx, withoutPreview(params))
      )
  )
}
