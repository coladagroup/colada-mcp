import { messages, ToolError } from '../../../errors.js'
import {
  type BudgetRow,
  calculate,
  calculateHierarchyTotal,
  calculateReserveRowAmount,
  type ExchangeRates,
  parseBudgetData
} from '../budgetMath.js'
import { defined } from './common.js'
import type { Fields } from './offer.js'

const LINEAR_FEE_MODE = 'linear'
const INTERNAL_SERVICE = 'internal'
const RESERVE_EFFORT = 'reserve'

interface RowFields {
  name?: string
  pdfDescription?: string
  price?: number
  q1?: number
  u1?: string
  q2?: number
  u2?: string
}

export type RowInput =
  | (RowFields & { type: 'kb'; kbItem: string })
  | (RowFields & { type: 'free'; name: string })
  | { type: 'group'; name: string; children: RowInput[] }

export type PlacedInput = RowInput & { parentRow?: string; position?: number }

export interface Built {
  row: Fields
  parentRow?: string
  position?: number
}

export interface Place {
  parentRow: string | null
  position: number
}

export interface Edit {
  item: unknown
  field: string
  from: unknown
  to: unknown
}

function pickCurrency(content: Fields, field: string, currency: string) {
  const value = content[field]
  if (!value) return
  const picked = (value as Fields)[currency]
  if (picked) content[field] = Number(picked)
  else delete content[field]
}

export function convertKnowledgeBaseItem(data: Fields, currency: string, newUid: () => string): Fields {
  const item: Fields = { ...data, ref: data.uid, uid: newUid() }
  delete item.root
  delete item.selected
  if (item.content) {
    const content: Fields = { ...(item.content as Fields) }
    pickCurrency(content, 'price', currency)
    pickCurrency(content, 'offset', currency)
    for (const field of ['baseMin', 'baseMax']) {
      if (content[field] && typeof content[field] === 'object') {
        content[field] = Number((content[field] as Fields)[currency]) || 0
      }
    }
    item.content = {
      ...content,
      price: content.price || 0,
      offset: content.offset || 0,
      pdfDescription: content.pdfDescription || '',
      selectedQuantity: content.selectedQuantity || 1,
      quantityType: content.quantityType || '',
      qty2: content.qty2 || 0,
      quantity2Unit: content.quantity2Unit || '',
      shortDescription: content.shortDescription || '',
      effort: content.effort || '',
      feeMode: content.feeMode || LINEAR_FEE_MODE,
      baseMin: content.baseMin || 0,
      rateAtMin: content.rateAtMin || 0,
      baseMax: content.baseMax || 0,
      rateAtMax: content.rateAtMax || 0,
      ...(content.internal ? { service: INTERNAL_SERVICE } : {})
    }
  }
  if (!item.content) item.content = { price: 0, offset: 0, selectedQuantity: 1 }
  if (Array.isArray(item.children) && item.children.length > 0) {
    item.subRows = item.children.map((child) => convertKnowledgeBaseItem(child as Fields, currency, newUid))
    delete item.children
  }
  return item
}

function tableFields(input: RowFields): Fields {
  return defined({
    price: input.price,
    selectedQuantity: input.q1 === undefined ? undefined : input.q1 || 1,
    quantityType: input.u1,
    qty2: input.q2,
    quantity2Unit: input.u2
  })
}

function applyEdits(row: Fields, input: RowFields, edits: Edit[]): Fields {
  if (input.name !== undefined && input.name !== row.name) {
    edits.push({ item: row.name ?? '', field: 'name', from: row.name ?? '', to: input.name })
    row.name = input.name
  }
  const content = { ...(row.content as Fields) }
  for (const [field, value] of Object.entries(tableFields(input))) {
    if (content[field] === value) continue
    edits.push({ item: row.name, field, from: content[field] ?? '', to: value })
    content[field] = value
  }
  if (input.pdfDescription !== undefined) content.pdfDescription = input.pdfDescription
  row.content = content
  return row
}

function emptyRow(newUid: () => string): Fields {
  return { uid: newUid(), name: '', content: { price: 0, selectedQuantity: 1 } }
}

export function buildRow(
  input: RowInput,
  currency: string,
  kbNode: (uid: string) => Fields,
  newUid: () => string,
  edits: Edit[]
): Fields {
  if (input.type === 'group') {
    const group = applyEdits(emptyRow(newUid), { name: input.name }, edits)
    group.subRows = input.children.map((child) => buildRow(child, currency, kbNode, newUid, edits))
    return group
  }
  const row =
    input.type === 'free' ? emptyRow(newUid) : convertKnowledgeBaseItem(kbNode(input.kbItem), currency, newUid)
  return applyEdits(row, input, edits)
}

function findRow(rows: Fields[], uid: string): Fields | null {
  for (const row of rows) {
    if (row.uid === uid) return row
    const found = findRow(parseBudgetData(row.subRows) as Fields[], uid)
    if (found) return found
  }
  return null
}

export function insertRows(current: unknown, built: Built[], offer: string): { list: Fields[]; places: Place[] } {
  const list = parseBudgetData(current) as Fields[]
  const places = built.map(({ row, parentRow, position }) => {
    let target = list
    if (parentRow !== undefined) {
      const parent = findRow(list, parentRow)
      if (!parent) throw new ToolError(messages.writeBadParentRow(parentRow, offer))
      target = parseBudgetData(parent.subRows) as Fields[]
      parent.subRows = target
    }
    const index = position ?? target.length
    if (index > target.length) throw new ToolError(messages.writeBadPosition(index, target.length))
    target.splice(index, 0, row)
    return { parentRow: parentRow ?? null, position: index }
  })
  return { list, places }
}

function siblingsOf(rows: BudgetRow[], uid: unknown): { row: BudgetRow; siblings: BudgetRow[] } | null {
  for (const row of rows) {
    if (row.uid === uid) return { row, siblings: rows }
    const found = siblingsOf(parseBudgetData(row.subRows), uid)
    if (found) return found
  }
  return null
}

export function rowAmount(list: BudgetRow[], uid: unknown, currency: string, rates: ExchangeRates): number {
  const found = siblingsOf(list, uid)
  if (!found) return 0
  if (found.row.content?.effort === RESERVE_EFFORT) {
    return calculateReserveRowAmount(found.row, found.siblings, currency, rates)
  }
  return calculateHierarchyTotal(found.row, false, calculate, true, currency, rates)
}

export function walkRows(rows: RowInput[], visit: (row: RowInput) => void): void {
  for (const row of rows) {
    visit(row)
    if (row.type === 'group') walkRows(row.children, visit)
  }
}
