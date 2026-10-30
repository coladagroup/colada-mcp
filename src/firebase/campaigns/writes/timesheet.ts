import { messages, ToolError } from '../../../errors.js'
import { type BudgetRow, parseBudgetData } from '../budgetMath.js'

export interface ReportFields {
  date?: string
  hours?: number
  minutes?: number
  project?: string
  entity?: string
  account?: string
  tag?: string
  description?: string
}

export type Entry = Record<string, unknown>

export interface CopyPlace {
  project: string
  row: string
  date: string
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export function localDate(nowSeconds: number): string {
  const now = new Date(nowSeconds * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function checkReportDate(date: string, today: string): void {
  const match = DATE.exec(date)
  const [year, month, day] = (match?.slice(1) ?? []).map(Number)
  const real = match && new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day ?? 0)).toISOString().startsWith(date)
  if (!real) throw new ToolError(messages.writeBadDate('date must be yyyy-MM-dd'))
  if (date > today) throw new ToolError(messages.writeBadDate(`date ${date} is in the future`))
}

function defined(fields: ReportFields): Entry {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}

export function newEntry(fields: ReportFields, key: string, owner: string): Entry {
  return { ...defined(fields), hours: fields.hours || 0, minutes: fields.minutes || 0, uid: key, owner }
}

export function mergeEntry(stored: Entry, fields: ReportFields): Entry {
  const next: Entry = { ...stored, ...defined(fields) }
  if (fields.project !== undefined && fields.project !== stored.project && fields.entity === undefined) {
    next.entity = ''
  }
  return { ...next, hours: next.hours || 0, minutes: next.minutes || 0 }
}

export function copyPlace(entry: Entry, onProject: boolean): CopyPlace | null {
  if (!onProject || typeof entry.entity !== 'string' || entry.entity === '') return null
  return { project: String(entry.project), row: entry.entity, date: String(entry.date) }
}

export function samePlace(a: CopyPlace | null, b: CopyPlace | null): boolean {
  return a !== null && b !== null && a.project === b.project && a.row === b.row && a.date === b.date
}

export function budgetList(stored: unknown, legacy: unknown): BudgetRow[] {
  const list = parseBudgetData(stored)
  return list.length === 0 && legacy != null ? parseBudgetData(legacy) : list
}

export function hasRow(list: BudgetRow[], uid: string): boolean {
  return list.some((row) => row.uid === uid || (Array.isArray(row.subRows) && hasRow(row.subRows, uid)))
}

function asItems(value: unknown): Entry[] {
  if (Array.isArray(value)) return value as Entry[]
  if (value !== null && typeof value === 'object') return Object.values(value) as Entry[]
  return []
}

function mapRows(list: BudgetRow[], change: (row: BudgetRow) => BudgetRow): BudgetRow[] {
  return list.map((row) => {
    const changed = change(row)
    if (!Array.isArray(changed.subRows) || changed.subRows.length === 0) return changed
    return { ...changed, subRows: mapRows(changed.subRows, change) }
  })
}

function reportsOf(row: BudgetRow): Record<string, unknown> {
  const reports = row.content?.reports
  return reports !== null && typeof reports === 'object' ? (reports as Record<string, unknown>) : {}
}

function withReports(row: BudgetRow, reports: Record<string, unknown>): BudgetRow {
  const content = { ...(row.content ?? {}) }
  if (Object.keys(reports).length === 0) delete content.reports
  else content.reports = reports
  return { ...row, content }
}

function requireRow(list: BudgetRow[], place: CopyPlace, workspace: string): void {
  if (!hasRow(list, place.row)) throw new ToolError(messages.writeMissingReference('Budget row', place.row, workspace))
}

export function withoutCopy(list: BudgetRow[], key: string): BudgetRow[] {
  return mapRows(list, (row) => {
    const reports = reportsOf(row)
    if (!Object.values(reports).some((items) => asItems(items).some((item) => item.uid === key))) return row
    const kept: Record<string, unknown> = {}
    for (const [date, items] of Object.entries(reports)) {
      const rest = asItems(items).filter((item) => item.uid !== key)
      if (rest.length > 0) kept[date] = rest
    }
    return withReports(row, kept)
  })
}

export function withCopy(list: BudgetRow[], place: CopyPlace, entry: Entry, workspace: string): BudgetRow[] {
  requireRow(list, place, workspace)
  const key = String(entry.uid)
  return mapRows(withoutCopy(list, key), (row) => {
    if (row.uid !== place.row) return row
    const reports = reportsOf(row)
    return withReports(row, { ...reports, [place.date]: [...asItems(reports[place.date]), entry] })
  })
}

export function replaceCopy(list: BudgetRow[], place: CopyPlace, entry: Entry, workspace: string): BudgetRow[] {
  requireRow(list, place, workspace)
  const key = String(entry.uid)
  let found = false
  const replaced = mapRows(list, (row) => {
    if (row.uid !== place.row) return row
    const reports = reportsOf(row)
    const items = asItems(reports[place.date])
    if (!items.some((item) => item.uid === key)) return row
    found = true
    return withReports(row, { ...reports, [place.date]: items.map((item) => (item.uid === key ? entry : item)) })
  })
  return found ? replaced : withCopy(list, place, entry, workspace)
}
