import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { App } from '../app.js'
import type { RowInput } from '../firebase/campaigns/writes/budgetRow.js'
import {
  ADD_BUDGET_ROWS,
  addBudgetRows,
  REMOVE_BUDGET_ROWS,
  removeBudgetRows,
  UPDATE_BUDGET_ROW,
  updateBudgetRow
} from '../firebase/campaigns/writes/budgetRows.js'
import {
  previewShape,
  realmShape,
  runFirebaseWriteTool,
  WRITE_TOOL_ANNOTATIONS,
  withoutPreview,
  workspaceInput,
  writeInput
} from './run.js'

const NOTE =
  'The output lists every write in "written". There is no undo. Call with preview: true first to see the writes without sending them and check them with the user; on prod hosts the real call needs the previewId from that preview.'

const id = (what: string) => z.string().min(1).max(200).describe(what)
const name = z.string().min(1).max(500).describe('Row name.')

const rowFields = {
  pdfDescription: z.string().max(10000).optional().describe('Text for the offer PDF.'),
  price: z.number().optional().describe('Unit price in the offer currency.'),
  q1: z.number().optional().describe('Quantity (selectedQuantity). 0 is stored as 1, as in the app.'),
  u1: id('Unit uid from units for q1 (quantityType).').optional(),
  q2: z.number().optional().describe('Second quantity (qty2), for example days.'),
  u2: id('Unit uid from units for q2 (quantity2Unit).').optional()
}
const kbShape = {
  type: z.literal('kb'),
  kbItem: id('Uid of a knowledge base node. Its children become sub-rows.'),
  name: name.optional().describe('Overrides the knowledge base name.'),
  ...rowFields
}
const freeShape = { type: z.literal('free'), name, ...rowFields }
const placeShape = {
  parentRow: id('Uid of an existing budget row. The row goes into its sub-rows. Default: the top level.').optional(),
  position: z.number().int().min(0).optional().describe('Index in the target list, 0 = first. Default: at the end.')
}

const childRow: z.ZodType<RowInput> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.strictObject(kbShape),
    z.strictObject(freeShape),
    z.strictObject({ type: z.literal('group'), name, children: z.array(childRow).min(1).max(50) })
  ])
)
const groupShape = {
  type: z.literal('group'),
  name,
  children: z.array(childRow).min(1).max(50).describe('Rows of the group, in this order.')
}
const topRow = z.discriminatedUnion('type', [
  z.strictObject({ ...kbShape, ...placeShape }),
  z.strictObject({ ...freeShape, ...placeShape }),
  z.strictObject({ ...groupShape, ...placeShape })
])

export function registerBudgetTools(server: McpServer, app: App) {
  server.registerTool(
    ADD_BUDGET_ROWS,
    {
      description: `Adds rows to the budget of one Campaigns offer, as the budget table does: "kb" rows from the knowledge base (with their children, prices in the offer currency), "free" rows and "group" rows with children. Existing rows are not changed, except that replaceBlankRow: true removes the blank row of a new offer in the same write. Rows are applied in input order, so a later position counts the rows added before it. Then total and allocated of the offer are recomputed. ${NOTE}`,
      inputSchema: writeInput({
        ...realmShape(app),
        workspace: workspaceInput,
        ...previewShape,
        offer: id('Key of the offer in planner.'),
        rows: z.array(topRow).min(1).max(50),
        replaceBlankRow: z
          .boolean()
          .optional()
          .describe(
            'true: remove the blank top-level row (empty name, no price, no sub-rows) that a new offer gets, before the rows are added. Positions count without it.'
          )
      }),
      annotations: WRITE_TOOL_ANNOTATIONS
    },
    (params) =>
      runFirebaseWriteTool(app, ADD_BUDGET_ROWS, params, `plannerBudgets/${params.offer}`, (ctx) =>
        addBudgetRows(app, ctx, withoutPreview(params))
      )
  )
  server.registerTool(
    UPDATE_BUDGET_ROW,
    {
      description: `Changes one row of the budget of one Campaigns offer, as the budget table does: name, price, quantities, units and PDF text, and moves it with parentRow and position. Only the given fields change. Each changed field gets an "updated" history record; a move gets none, as in the app. Then total and allocated of the offer are recomputed. ${NOTE}`,
      inputSchema: writeInput({
        ...realmShape(app),
        workspace: workspaceInput,
        ...previewShape,
        offer: id('Key of the offer in planner.'),
        row: id('Uid of the budget row (see campaigns_budget).'),
        name: name.optional(),
        ...rowFields,
        parentRow: z
          .string()
          .max(200)
          .optional()
          .describe('Move the row into the sub-rows of this row. "" moves it to the top level. Default: where it is.'),
        position: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Move the row to this index in its target list, 0 = first. Default with parentRow: at the end.')
      }),
      annotations: WRITE_TOOL_ANNOTATIONS
    },
    (params) =>
      runFirebaseWriteTool(app, UPDATE_BUDGET_ROW, params, `plannerBudgets/${params.offer}`, (ctx) =>
        updateBudgetRow(app, ctx, withoutPreview(params))
      )
  )
  server.registerTool(
    REMOVE_BUDGET_ROWS,
    {
      description: `Removes rows from the budget of one Campaigns offer, as the budget table does, with one "itemRemoved" history record per row. A row with sub-rows is removed only with withSubRows: true. A row that has timesheet copies (in it or its sub-rows) is refused. The last row of a budget cannot be removed: add the new rows first. Only rows inside the budget are removed; no Firebase node is deleted. Then total and allocated of the offer are recomputed. ${NOTE}`,
      inputSchema: writeInput({
        ...realmShape(app),
        workspace: workspaceInput,
        ...previewShape,
        offer: id('Key of the offer in planner.'),
        rows: z.array(id('Uid of a budget row.')).min(1).max(50),
        withSubRows: z.boolean().optional().describe('true: also remove rows that have sub-rows, with their sub-rows.')
      }),
      annotations: WRITE_TOOL_ANNOTATIONS
    },
    (params) =>
      runFirebaseWriteTool(app, REMOVE_BUDGET_ROWS, params, `plannerBudgets/${params.offer}`, (ctx) =>
        removeBudgetRows(app, ctx, withoutPreview(params))
      )
  )
}
