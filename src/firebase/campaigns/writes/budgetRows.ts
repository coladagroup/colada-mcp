import { randomUUID } from 'node:crypto'
import type { App } from '../../../app.js'
import { messages, ToolError } from '../../../errors.js'
import type { FirebaseWriteToolContext } from '../../../tools/run.js'
import { isHiddenProject } from '../../policy/rows.js'
import type { PlannedWrite, WriteTool } from '../../policy/writes.js'
import { type BudgetRow, CHF_CURRENCY, calculateAllocated, calculateTotal, type ExchangeRates } from '../budgetMath.js'
import { type Built, buildRow, insertRows, type Place, type PlacedInput, rowAmount, walkRows } from './budgetRow.js'
import { assertId, open, partial, type Target, written } from './common.js'
import { conditionalWrite } from './conditional.js'
import { type Fields, findTreeNode } from './offer.js'

export const ADD_BUDGET_ROWS: WriteTool = 'campaigns_add_budget_rows'

function isRecord(value: unknown): value is Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export async function addBudgetRows(
  app: App,
  ctx: FirebaseWriteToolContext,
  input: Target & { offer: string; rows: PlacedInput[] }
) {
  const { offer, rows } = input
  assertId(offer)
  const kbItems: string[] = []
  const units: string[] = []
  walkRows(rows, (row) => {
    if (row.type === 'kb') kbItems.push(row.kbItem)
    if (row.type !== 'group') units.push(...[row.u1, row.u2].filter((unit): unit is string => unit !== undefined))
  })
  for (const id of [...kbItems, ...rows.flatMap((row) => (row.parentRow === undefined ? [] : [row.parentRow]))]) {
    assertId(id)
  }
  const planned: PlannedWrite[] = [
    { method: 'PUT', path: `plannerBudgets/${offer}` },
    { method: 'PATCH', path: `planner/${offer}/total` },
    { method: 'PATCH', path: `planner/${offer}/allocated` }
  ]
  const session = await open(app, ctx, ADD_BUDGET_ROWS, input, planned)
  const workspace = session.writer.workspace

  const stored = (await session.writer.read(`planner/${offer}`)).value
  if (!isRecord(stored)) throw new ToolError(messages.writeMissingReference('Offer', offer, workspace))
  if (isHiddenProject(stored, session.uid, session.role)) throw new ToolError(messages.writeHidden('Offer', offer))
  if (stored.archived) throw new ToolError(messages.writeArchived(offer))
  const currency = typeof stored.currency === 'string' && stored.currency !== '' ? stored.currency : CHF_CURRENCY
  const rates = (isRecord(stored.exchangeRates) ? stored.exchangeRates : null) as ExchangeRates

  const knowledgeBase = kbItems.length > 0 ? (await session.writer.read('knowledgeBase')).value : null
  const kbNode = (uid: string) => {
    const found = findTreeNode(knowledgeBase, uid)
    if (!found) throw new ToolError(messages.writeMissingReference('Knowledge base item', uid, workspace))
    return found
  }
  if (units.length > 0) {
    const known = Object.values((await session.writer.read('units')).value ?? {}) as Fields[]
    const missing = units.find((unit) => !known.some((stored) => stored?.uid === unit))
    if (missing !== undefined) throw new ToolError(messages.writeMissingReference('Unit', missing, workspace))
  }

  const built: Built[] = rows.map((row) => ({
    row: buildRow(row, currency, kbNode, randomUUID),
    parentRow: row.parentRow,
    position: row.position
  }))
  let places: Place[] = []
  const result = await conditionalWrite(session.writer, `plannerBudgets/${offer}`, (current) => {
    const inserted = insertRows(current, structuredClone(built), offer)
    places = inserted.places
    return inserted.list
  })
  const list = result.value as BudgetRow[]
  const total = calculateTotal(list, false, currency, rates)
  const allocated = calculateAllocated(list)
  try {
    await session.writer.patch(`planner/${offer}`, { total, allocated })
  } catch (err) {
    partial(
      ctx,
      ADD_BUDGET_ROWS,
      [`planner/${offer}/total`, `planner/${offer}/allocated`],
      'The rows are saved, but total and allocated of the offer are not updated. The next budget save in the UI recomputes them.',
      err
    )
  }
  return {
    offer,
    rows: built.map(({ row }, index) => ({
      uid: row.uid,
      ...(row.ref === undefined ? {} : { ref: row.ref }),
      name: row.name,
      ...places[index],
      amount: rowAmount(list, row.uid, currency, rates)
    })),
    total,
    allocated,
    written: written(ctx),
    retries: result.retries
  }
}
