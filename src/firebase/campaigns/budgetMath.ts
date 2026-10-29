export interface BudgetContent {
  price?: unknown
  selectedQuantity?: unknown
  quantityType?: unknown
  qty2?: unknown
  quantity2Unit?: unknown
  disc?: unknown
  vat?: unknown
  currency?: unknown
  offset?: unknown
  allocated?: unknown
  effort?: unknown
  feeMode?: unknown
  baseMin?: unknown
  baseMax?: unknown
  rateAtMin?: unknown
  rateAtMax?: unknown
  reports?: unknown
  invoices?: unknown
}

export interface BudgetRow {
  uid?: unknown
  name?: unknown
  content?: BudgetContent
  subRows?: BudgetRow[]
}

export type ExchangeRates = Record<string, number> | null

type RowFunction = (item: BudgetRow, includeEffort: boolean, currency: string, rates: ExchangeRates) => number

export const CHF_CURRENCY = 'CHF'
const OPTION_EFFORT = 'option'
const RECURRING_EFFORT = 'recurring'
const NIP_EFFORT = 'nip'
const RESERVE_EFFORT = 'reserve'
const NONLINEAR_FEE_MODE = 'nonlinear'

const hasSubRows = (item: BudgetRow): item is BudgetRow & { subRows: BudgetRow[] } =>
  Array.isArray(item.subRows) && item.subRows.length > 0

function multiplied(price: number, content: BudgetContent, currency: string, rates: ExchangeRates): number {
  let result = price
  if (content.selectedQuantity || content.selectedQuantity === 0) result *= Number(content.selectedQuantity)
  if (content.qty2) result *= Number(content.qty2)
  if (content.disc) result *= 1 - Number(content.disc) / 100
  if (content.vat) result *= 1 + Number(content.vat) / 100
  if (content.currency && content.currency !== currency && rates) result *= rates[String(content.currency)] || 1
  return result
}

export function calculate(
  curr: BudgetRow,
  includeEffort = false,
  currency = CHF_CURRENCY,
  rates: ExchangeRates = null
): number {
  const price = curr.content?.price ? Number(curr.content.price) : 0
  const content = curr.content
  if (!content) return price
  const effort = content.effort
  if (
    effort === NIP_EFFORT ||
    effort === RESERVE_EFFORT ||
    (!includeEffort && effort && (effort === OPTION_EFFORT || effort === RECURRING_EFFORT))
  ) {
    return 0
  }
  return multiplied(price, content, currency, rates)
}

function calculateInvoices(item: BudgetRow, rates: ExchangeRates): number {
  let sum = 0
  const invoices = item.content?.invoices
  if (Array.isArray(invoices)) {
    for (const invoice of invoices as Array<{ amount?: unknown; currency?: unknown }>) {
      sum += Number(invoice?.amount) * (rates?.[String(invoice?.currency)] || 1)
    }
  }
  return sum
}

export function reportedMinutes(item: BudgetRow): number {
  let sum = 0
  const reports = item.content?.reports
  if (reports && typeof reports === 'object') {
    for (const dateReport of Object.values(reports)) {
      if (!Array.isArray(dateReport)) continue
      for (const report of dateReport as Array<{ hours?: unknown; minutes?: unknown }>) {
        sum += Number(report?.hours) * 60 + Number(report?.minutes)
      }
    }
  }
  return sum
}

function calculateTimeReports(item: BudgetRow): number {
  const sum = reportedMinutes(item)
  return sum > 0 ? (sum / 60) * Number(item.content?.price) : 0
}

export function calculateReports(
  item: BudgetRow,
  _includeEffort = false,
  _currency = CHF_CURRENCY,
  rates: ExchangeRates = null
): number {
  return calculateTimeReports(item) + calculateInvoices(item, rates)
}

function convertedOffset(item: BudgetRow, currency: string, rates: ExchangeRates): number {
  let offset = Number(item.content?.offset) || 0
  if (item.content?.currency && item.content.currency !== currency && rates) {
    offset *= rates[String(item.content.currency)] || 1
  }
  return offset
}

export function nonlinearRate(base: number, content: BudgetContent | undefined, clamp = true): number {
  const baseMin = Number(content?.baseMin) || 0
  const baseMax = Number(content?.baseMax) || 0
  const rateAtMin = Number(content?.rateAtMin) || 0
  const rateAtMax = Number(content?.rateAtMax) || 0
  if (baseMax === baseMin) return rateAtMin
  const slope = (rateAtMin - rateAtMax) / (baseMax - baseMin)
  const rate = rateAtMin - (base - baseMin) * slope
  return clamp ? Math.min(Math.max(rate, rateAtMax), rateAtMin) : rate
}

export function reserveFeeAmount(row: BudgetRow, base: number, currency = CHF_CURRENCY, rates: ExchangeRates = null) {
  const offset = convertedOffset(row, currency, rates)
  if (row.content?.feeMode === NONLINEAR_FEE_MODE) return (base * nonlinearRate(base, row.content)) / 100 + offset
  return (base * (Number(row.content?.selectedQuantity) || 0)) / 100 + offset
}

function reserveContribution(rows: BudgetRow[], base: number, currency: string, rates: ExchangeRates): number {
  return rows.reduce(
    (sum, row) => (row.content?.effort === RESERVE_EFFORT ? sum + reserveFeeAmount(row, base, currency, rates) : sum),
    0
  )
}

function siblingBaseTotal(siblings: BudgetRow[], includeEffort: boolean, currency: string, rates: ExchangeRates) {
  return siblings.reduce((sum, row) => {
    if (row.content?.effort === RESERVE_EFFORT) return sum
    if (hasSubRows(row)) return sum + calculateHierarchyTotal(row, includeEffort, calculate, true, currency, rates)
    return sum + calculate(row, includeEffort, currency, rates)
  }, 0)
}

export function calculateReserveRowAmount(
  item: BudgetRow,
  siblings: BudgetRow[] | null,
  currency = CHF_CURRENCY,
  rates: ExchangeRates = null,
  includeEffort = false
): number {
  if (item.content?.effort !== RESERVE_EFFORT || !siblings) return 0
  return reserveFeeAmount(item, siblingBaseTotal(siblings, includeEffort, currency, rates), currency, rates)
}

export function calculateHierarchyTotal(
  item: BudgetRow,
  includeEffort = false,
  calculateFunction: RowFunction = calculate,
  withReserve = true,
  currency = CHF_CURRENCY,
  rates: ExchangeRates = null
): number {
  if (!hasSubRows(item)) return calculateFunction(item, includeEffort, currency, rates)
  const reducer = (sum: number, row: BudgetRow): number => {
    let subTotal: number
    if (hasSubRows(row)) {
      subTotal = row.subRows.reduce(reducer, 0)
      if (withReserve) subTotal += reserveContribution(row.subRows, subTotal, currency, rates)
    } else {
      subTotal = calculateFunction(row, includeEffort, currency, rates)
    }
    return subTotal + sum
  }
  let total = item.subRows.reduce(reducer, 0)
  if (withReserve) total += reserveContribution(item.subRows, total, currency, rates)
  return total
}

export function calculateTotal(
  items: BudgetRow[],
  includeEffort = false,
  currency = CHF_CURRENCY,
  rates: ExchangeRates = null
): number {
  let total = items.reduce(
    (sum, row) => sum + calculateHierarchyTotal(row, includeEffort, calculate, true, currency, rates),
    0
  )
  total += reserveContribution(items, total, currency, rates)
  return total
}

export function calculateAllocated(items: BudgetRow[]): number {
  return items.reduce(
    (sum, row) => sum + calculateHierarchyTotal(row, false, (item) => (item.content?.allocated || 0) as number, false),
    0
  )
}

export function calculateReportsTotal(items: BudgetRow[], rates: ExchangeRates = null): number {
  return items.reduce((sum, row) => sum + calculateHierarchyTotal(row, false, calculateReports, false, '', rates), 0)
}

export function parseBudgetData(value: unknown): BudgetRow[] {
  if (value == null) return []
  if (Array.isArray(value)) return value as BudgetRow[]
  if (typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  if (record.list != null) return parseBudgetData(record.list)
  const keys = Object.keys(record)
  if (keys.length === 0) return []
  if (keys.every((key) => /^\d+$/.test(key))) {
    return keys.sort((a, b) => Number(a) - Number(b)).map((key) => record[key] as BudgetRow)
  }
  if (record.uid && record.content) return [record as BudgetRow]
  return Object.values(record) as BudgetRow[]
}

export interface FlatBudgetRow {
  uid: unknown
  depth: number
  path: string
  name: unknown
  isGroup: boolean
  effort: unknown
  price: unknown
  quantity: unknown
  quantityUnit: unknown
  quantity2: unknown
  quantity2Unit: unknown
  discount: unknown
  vat: unknown
  currency: unknown
  allocated: unknown
  total: number
  reserveAmount?: number
  reportedHours: number
  actual: number
}

export function flattenBudget(
  rows: BudgetRow[],
  currency = CHF_CURRENCY,
  rates: ExchangeRates = null,
  depth = 0,
  parentPath = ''
): FlatBudgetRow[] {
  const result: FlatBudgetRow[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const content = row.content ?? {}
    const label = typeof row.name === 'string' && row.name !== '' ? row.name : String(row.uid ?? '')
    const path = parentPath ? `${parentPath} > ${label}` : label
    const group = hasSubRows(row)
    result.push({
      uid: row.uid ?? null,
      depth,
      path,
      name: row.name ?? null,
      isGroup: group,
      effort: content.effort ?? null,
      price: content.price ?? null,
      quantity: content.selectedQuantity ?? null,
      quantityUnit: content.quantityType ?? null,
      quantity2: content.qty2 ?? null,
      quantity2Unit: content.quantity2Unit ?? null,
      discount: content.disc ?? null,
      vat: content.vat ?? null,
      currency: content.currency ?? null,
      allocated: content.allocated ?? null,
      total: calculateHierarchyTotal(row, false, calculate, true, currency, rates),
      ...(content.effort === RESERVE_EFFORT
        ? { reserveAmount: calculateReserveRowAmount(row, rows, currency, rates) }
        : {}),
      reportedHours: group ? 0 : reportedMinutes(row) / 60,
      actual: calculateHierarchyTotal(row, false, calculateReports, false, '', rates)
    })
    if (group) result.push(...flattenBudget(row.subRows ?? [], currency, rates, depth + 1, path))
  }
  return result
}
