import { randomUUID } from 'node:crypto'
import type { App } from '../../../app.js'
import { fail } from '../../../errors.js'
import type { FirebaseWriteToolContext } from '../../../tools/run.js'
import { isHiddenProject } from '../../policy/rows.js'
import type { PlannedWrite, WriteTool } from '../../policy/writes.js'
import {
  type BudgetRow,
  CHF_CURRENCY,
  calculateAllocated,
  calculateTotal,
  type ExchangeRates,
  parseBudgetData
} from '../budgetMath.js'
import {
  applyEdits,
  type Built,
  buildRow,
  containsRow,
  type Edit,
  insertRows,
  isBlankRow,
  locateRow,
  type Place,
  type PlacedInput,
  type RowFields,
  reportCount,
  rowAmount,
  walkRows
} from './budgetRow.js'
import { assertId, nowJson, open, partial, type Session, type Target, written } from './common.js'
import { conditionalWrite } from './conditional.js'
import { type Fields, findTreeNode } from './offer.js'
import { pushKey } from './pushKey.js'

export const ADD_BUDGET_ROWS: WriteTool = 'campaigns_add_budget_rows'
export const UPDATE_BUDGET_ROW: WriteTool = 'campaigns_update_budget_row'
export const REMOVE_BUDGET_ROWS: WriteTool = 'campaigns_remove_budget_rows'

interface OfferBudget {
  currency: string
  rates: ExchangeRates
}

function isRecord(value: unknown): value is Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function historyRecords(app: App, edits: Edit[], user: string, offer: string): Fields {
  const nowMs = app.deps.now() * 1000
  const date = nowJson(app)
  return Object.fromEntries(
    edits.map((edit, index) => {
      const uid = pushKey(nowMs + index)
      const record = {
        uid,
        module: 'budget',
        item: edit.item,
        field: edit.field,
        from: edit.from,
        to: edit.to,
        action: edit.action ?? 'updated',
        date,
        user,
        source: offer,
        type: 'string',
        valueType: 'string'
      }
      return [`history/${uid}`, record]
    })
  )
}

function plannedFor(offer: string): PlannedWrite[] {
  return [
    { method: 'PUT', path: `plannerBudgets/${offer}` },
    { method: 'PATCH', path: `planner/${offer}/total` },
    { method: 'PATCH', path: `planner/${offer}/allocated` }
  ]
}

async function loadOffer(session: Session, offer: string): Promise<OfferBudget> {
  const stored = (await session.writer.read(`planner/${offer}`)).value
  if (!isRecord(stored)) throw fail.writeMissingReference('Offer', offer, session.writer.workspace)
  if (isHiddenProject(stored, session.uid, session.role)) throw fail.writeHidden('Offer', offer)
  if (stored.archived) throw fail.writeArchived(offer)
  return {
    currency: typeof stored.currency === 'string' && stored.currency !== '' ? stored.currency : CHF_CURRENCY,
    rates: (isRecord(stored.exchangeRates) ? stored.exchangeRates : null) as ExchangeRates
  }
}

async function checkUnits(session: Session, units: string[]) {
  if (units.length === 0) return
  const known = Object.values((await session.writer.read('units')).value ?? {}) as Fields[]
  const missing = units.find((unit) => !known.some((stored) => stored?.uid === unit))
  if (missing !== undefined) throw fail.writeMissingReference('Unit', missing, session.writer.workspace)
}

async function saveTotals(
  app: App,
  ctx: FirebaseWriteToolContext,
  tool: WriteTool,
  session: Session,
  offer: string,
  list: BudgetRow[],
  budget: OfferBudget,
  edits: Edit[],
  saved: string
) {
  const total = calculateTotal(list, false, budget.currency, budget.rates)
  const allocated = calculateAllocated(list)
  const history = historyRecords(app, edits, session.uid, offer)
  try {
    await session.writer.patch('', {
      [`planner/${offer}/total`]: total,
      [`planner/${offer}/allocated`]: allocated,
      ...history
    })
  } catch (err) {
    const records = Object.keys(history).length
    partial(
      ctx,
      tool,
      [`planner/${offer}/total`, `planner/${offer}/allocated`, ...(records > 0 ? [`${records} history records`] : [])],
      `${saved}, but total and allocated of the offer and the history records are not written. The next budget save in the UI recomputes the totals.`,
      err
    )
  }
  return { total, allocated }
}

export async function addBudgetRows(
  app: App,
  ctx: FirebaseWriteToolContext,
  input: Target & { offer: string; rows: PlacedInput[]; replaceBlankRow?: boolean }
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
  const session = await open(app, ctx, ADD_BUDGET_ROWS, input, plannedFor(offer))
  const workspace = session.writer.workspace
  const budget = await loadOffer(session, offer)

  const knowledgeBase = kbItems.length > 0 ? (await session.writer.read('knowledgeBase')).value : null
  const kbNode = (uid: string) => {
    const found = findTreeNode(knowledgeBase, uid)
    if (!found) throw fail.writeMissingReference('Knowledge base item', uid, workspace)
    return found
  }
  await checkUnits(session, units)

  const edits: Edit[] = []
  const built: Built[] = rows.map((row) => ({
    row: buildRow(row, budget.currency, kbNode, randomUUID, edits),
    parentRow: row.parentRow,
    position: row.position
  }))
  let places: Place[] = []
  let replaced: string | null = null
  const result = await conditionalWrite(session.writer, `plannerBudgets/${offer}`, (current) => {
    let base = current
    replaced = null
    if (input.replaceBlankRow) {
      const list = parseBudgetData(current) as Fields[]
      const blank = list.findIndex(isBlankRow)
      if (blank < 0) throw fail.writeNoBlankRow(offer)
      replaced = String(list[blank]?.uid)
      base = list.filter((_, index) => index !== blank)
    }
    const inserted = insertRows(base, structuredClone(built), offer)
    places = inserted.places
    return inserted.list
  })
  const list = result.value as BudgetRow[]
  const { total, allocated } = await saveTotals(
    app,
    ctx,
    ADD_BUDGET_ROWS,
    session,
    offer,
    list,
    budget,
    edits,
    'The rows are saved'
  )
  return {
    offer,
    rows: built.map(({ row }, index) => ({
      uid: row.uid,
      ...(row.ref === undefined ? {} : { ref: row.ref }),
      name: row.name,
      ...places[index],
      amount: rowAmount(list, row.uid, budget.currency, budget.rates)
    })),
    ...(input.replaceBlankRow ? { replacedBlankRow: replaced } : {}),
    total,
    allocated,
    written: written(ctx),
    retries: result.retries
  }
}

export interface UpdateRowInput extends Target, RowFields {
  offer: string
  row: string
  parentRow?: string
  position?: number
}

export async function updateBudgetRow(app: App, ctx: FirebaseWriteToolContext, input: UpdateRowInput) {
  const { offer, row: uid, parentRow, position } = input
  const fields: RowFields = {
    name: input.name,
    pdfDescription: input.pdfDescription,
    price: input.price,
    q1: input.q1,
    u1: input.u1,
    q2: input.q2,
    u2: input.u2
  }
  const move = parentRow !== undefined || position !== undefined
  if (!move && Object.values(fields).every((value) => value === undefined)) throw fail.writeNoFields('offer and row')
  for (const id of [offer, uid, ...(parentRow ? [parentRow] : [])]) assertId(id)
  const session = await open(app, ctx, UPDATE_BUDGET_ROW, input, plannedFor(offer))
  const budget = await loadOffer(session, offer)
  await checkUnits(
    session,
    [input.u1, input.u2].filter((unit): unit is string => unit !== undefined)
  )

  let edits: Edit[] = []
  let pdfChanged = false
  let place: Place = { parentRow: null, position: 0 }
  const result = await conditionalWrite(session.writer, `plannerBudgets/${offer}`, (current) => {
    const list = parseBudgetData(current) as Fields[]
    const found = locateRow(list, uid)
    if (!found) throw fail.writeUnknownRow(uid, offer)
    edits = []
    const before = (found.row.content as Fields | undefined)?.pdfDescription ?? ''
    pdfChanged = fields.pdfDescription !== undefined && fields.pdfDescription !== before
    applyEdits(found.row, fields, edits)
    const from = found.siblings.indexOf(found.row)
    place = { parentRow: found.parent ? String(found.parent.uid) : null, position: from }
    if (!move) return list
    const target = parentRow === undefined ? place.parentRow : parentRow === '' ? null : parentRow
    if (target !== null && containsRow(found.row, target)) throw fail.writeBadMove(uid)
    found.siblings.splice(from, 1)
    let siblings = list
    if (target !== null) {
      const parent = locateRow(list, target)
      if (!parent) throw fail.writeBadParentRow(target, offer)
      siblings = parseBudgetData(parent.row.subRows) as Fields[]
      parent.row.subRows = siblings
    }
    const index = position ?? siblings.length
    if (index > siblings.length) throw fail.writeBadPosition(index, siblings.length)
    siblings.splice(index, 0, found.row)
    place = { parentRow: target, position: index }
    return list
  })
  const list = result.value as BudgetRow[]
  const changed = [...edits.map((edit) => edit.field), ...(pdfChanged ? ['pdfDescription'] : [])]
  if (!result.written) {
    return {
      offer,
      row: { uid, ...place },
      changed: [],
      unchanged: true,
      written: written(ctx),
      retries: result.retries
    }
  }
  const { total, allocated } = await saveTotals(
    app,
    ctx,
    UPDATE_BUDGET_ROW,
    session,
    offer,
    list,
    budget,
    edits,
    'The row is saved'
  )
  const saved = locateRow(list as Fields[], uid)?.row
  return {
    offer,
    row: { uid, name: saved?.name ?? null, ...place, amount: rowAmount(list, uid, budget.currency, budget.rates) },
    changed,
    total,
    allocated,
    written: written(ctx),
    retries: result.retries
  }
}

export async function removeBudgetRows(
  app: App,
  ctx: FirebaseWriteToolContext,
  input: Target & { offer: string; rows: string[]; withSubRows?: boolean }
) {
  const { offer } = input
  const uids = [...new Set(input.rows)]
  for (const id of [offer, ...uids]) assertId(id)
  const session = await open(app, ctx, REMOVE_BUDGET_ROWS, input, plannedFor(offer))
  const budget = await loadOffer(session, offer)

  let edits: Edit[] = []
  let removed: Array<{ uid: string; name: unknown; subRows: number }> = []
  const result = await conditionalWrite(session.writer, `plannerBudgets/${offer}`, (current) => {
    const list = parseBudgetData(current) as Fields[]
    edits = []
    removed = []
    const removedRows: Fields[] = []
    for (const uid of uids) {
      const found = locateRow(list, uid)
      if (!found && removedRows.some((row) => containsRow(row, uid))) continue
      if (!found) throw fail.writeUnknownRow(uid, offer)
      const subRows = parseBudgetData(found.row.subRows).length
      if (subRows > 0 && !input.withSubRows) throw fail.writeRowHasSubRows(uid)
      const copies = reportCount(found.row)
      if (copies > 0) throw fail.writeRowHasReports(uid, String(found.row.name ?? ''), copies)
      found.siblings.splice(found.siblings.indexOf(found.row), 1)
      removedRows.push(found.row)
      removed.push({ uid, name: found.row.name ?? '', subRows })
      edits.push({ item: found.row.name ?? '', field: '', from: '', to: '', action: 'itemRemoved' })
    }
    if (list.length === 0) throw fail.writeLastRow(offer)
    return list
  })
  const list = result.value as BudgetRow[]
  const { total, allocated } = await saveTotals(
    app,
    ctx,
    REMOVE_BUDGET_ROWS,
    session,
    offer,
    list,
    budget,
    edits,
    'The rows are removed'
  )
  return { offer, removed, total, allocated, written: written(ctx), retries: result.retries }
}
