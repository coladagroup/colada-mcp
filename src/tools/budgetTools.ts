import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { App } from '../app.js'
import type { RowInput } from '../firebase/campaigns/writes/budgetRow.js'
import { ADD_BUDGET_ROWS, addBudgetRows } from '../firebase/campaigns/writes/budgetRows.js'
import { realmShape, runFirebaseWriteTool, WRITE_TOOL_ANNOTATIONS, workspaceInput, writeInput } from './run.js'

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
      description:
        'Adds rows to the budget of one Campaigns offer, as the budget table does: "kb" rows from the knowledge base (with their children, prices in the offer currency), "free" rows and "group" rows with children. Existing rows are not changed. Rows are applied in input order, so a later position counts the rows added before it. Then total and allocated of the offer are recomputed. The output lists every write in "written". There is no undo and no dry run: check the rows with the user first.',
      inputSchema: writeInput({
        ...realmShape(app),
        workspace: workspaceInput,
        offer: id('Key of the offer in planner.'),
        rows: z.array(topRow).min(1).max(50)
      }),
      annotations: WRITE_TOOL_ANNOTATIONS
    },
    (params) =>
      runFirebaseWriteTool(
        app,
        ADD_BUDGET_ROWS,
        params.realm,
        {
          app: 'campaigns',
          store: 'rtdb',
          method: 'PUT',
          path: `plannerBudgets/${params.offer}`,
          paths: null,
          ifMatch: true,
          retries: 0
        },
        (ctx) => addBudgetRows(app, ctx, params)
      )
  )
}
