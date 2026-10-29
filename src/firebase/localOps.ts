import { messages, ToolError } from '../errors.js'

export type WhereOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in' | 'exists' | 'missing'
export type Scalar = string | number | boolean | null

export interface WhereItem {
  field: string
  op: WhereOp
  value?: Scalar | Scalar[]
}

export interface LocalOps {
  where?: WhereItem[]
  fields?: string[]
  groupBy?: string[]
  sum?: string[]
}

export interface Group {
  key: Record<string, Scalar>
  count: number
  sums: Record<string, number>
}

export interface Grouped {
  groups: Group[]
  total: { count: number; sums: Record<string, number> }
}

const BUCKETS = ['day', 'week', 'month', 'year'] as const
type Bucket = (typeof BUCKETS)[number]
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/

const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

export function assertSafeFieldPath(field: string, option: string) {
  if (field.split('.').some((segment) => UNSAFE_SEGMENTS.has(segment))) {
    throw new ToolError(
      messages.firebaseQuery(
        `"${field}" in ${option}: __proto__, constructor and prototype are not allowed in a field path`
      )
    )
  }
}

export function hasLocalOps(ops: LocalOps): boolean {
  return Boolean(ops.where?.length || ops.fields?.length || ops.groupBy?.length || ops.sum?.length)
}

export function fieldsUsed(ops: LocalOps): Array<{ field: string; option: string }> {
  return [
    ...(ops.where ?? []).map(({ field }) => ({ field, option: 'where' })),
    ...(ops.fields ?? []).map((field) => ({ field, option: 'fields' })),
    ...(ops.groupBy ?? []).map((spec) => ({ field: parseGroupKey(spec).field, option: 'groupBy' })),
    ...(ops.sum ?? []).map((field) => ({ field, option: 'sum' }))
  ]
}

function parseGroupKey(spec: string): { field: string; bucket: Bucket | null } {
  const index = spec.lastIndexOf(':')
  if (index < 0) return { field: spec, bucket: null }
  const bucket = spec.slice(index + 1)
  if (!(BUCKETS as readonly string[]).includes(bucket)) {
    throw new ToolError(messages.firebaseQuery(`groupBy "${spec}": the bucket must be one of ${BUCKETS.join(', ')}`))
  }
  return { field: spec.slice(0, index), bucket: bucket as Bucket }
}

function valueAt(record: unknown, field: string): unknown {
  let current = record
  for (const segment of field.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function compare(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  return null
}

function matches(record: unknown, item: WhereItem): boolean {
  const actual = valueAt(record, item.field)
  switch (item.op) {
    case 'exists':
      return actual !== undefined && actual !== null
    case 'missing':
      return actual === undefined || actual === null
    case 'eq':
      return actual === item.value
    case 'ne':
      return actual !== item.value
    case 'in':
      return Array.isArray(item.value) && item.value.includes(actual as Scalar)
    default: {
      const diff = compare(actual, item.value)
      if (diff === null) return false
      if (item.op === 'lt') return diff < 0
      if (item.op === 'lte') return diff <= 0
      if (item.op === 'gt') return diff > 0
      return diff >= 0
    }
  }
}

function project(record: unknown, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    const value = valueAt(record, field)
    if (value === undefined) continue
    const segments = field.split('.')
    let target = result
    segments.forEach((segment, index) => {
      if (index === segments.length - 1) target[segment] = value
      else {
        const next = target[segment]
        target[segment] = next !== null && typeof next === 'object' ? next : {}
        target = target[segment] as Record<string, unknown>
      }
    })
  }
  return result
}

export function isoWeek(date: string): string | null {
  const match = ISO_DATE.exec(date)
  if (!match) return null
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (Number.isNaN(day.getTime())) return null
  const weekday = day.getUTCDay() || 7
  day.setUTCDate(day.getUTCDate() + 4 - weekday)
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function bucketOf(value: unknown, bucket: Bucket): string | null {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null
  if (bucket === 'day') return value.slice(0, 10)
  if (bucket === 'month') return value.slice(0, 7)
  if (bucket === 'year') return value.slice(0, 4)
  return isoWeek(value)
}

function keyValue(value: unknown): Scalar {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return JSON.stringify(value)
}

function numberOf(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function roundSum(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

export function applyLocalOps(records: Record<string, unknown>, ops: LocalOps): Record<string, unknown> | Grouped {
  let entries = Object.entries(records)
  for (const item of ops.where ?? []) entries = entries.filter(([, record]) => matches(record, item))
  if (ops.groupBy?.length || ops.sum?.length)
    return group(
      entries.map(([, record]) => record),
      ops
    )
  if (ops.fields?.length) {
    const fields = ops.fields
    entries = entries.map(([key, record]) => [key, project(record, fields)])
  }
  return Object.fromEntries(entries)
}

function group(records: unknown[], ops: LocalOps): Grouped {
  const keys = (ops.groupBy ?? []).map((spec) => ({ spec, ...parseGroupKey(spec) }))
  const sumFields = ops.sum ?? []
  const groups = new Map<string, Group>()
  const total = { count: 0, sums: Object.fromEntries(sumFields.map((field) => [field, 0])) }
  for (const record of records) {
    const key: Record<string, Scalar> = {}
    for (const { spec, field, bucket } of keys) {
      const raw = valueAt(record, field)
      key[spec] = bucket ? bucketOf(raw, bucket) : keyValue(raw)
    }
    const id = JSON.stringify(keys.map(({ spec }) => key[spec]))
    let entry = groups.get(id)
    if (!entry) {
      entry = { key, count: 0, sums: Object.fromEntries(sumFields.map((field) => [field, 0])) }
      groups.set(id, entry)
    }
    entry.count++
    total.count++
    for (const field of sumFields) {
      const value = numberOf(valueAt(record, field))
      entry.sums[field] = (entry.sums[field] ?? 0) + value
      total.sums[field] = (total.sums[field] ?? 0) + value
    }
  }
  const rounded = (sums: Record<string, number>) =>
    Object.fromEntries(Object.entries(sums).map(([field, value]) => [field, roundSum(value)]))
  return {
    groups: [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, entry]) => ({ ...entry, sums: rounded(entry.sums) })),
    total: { count: total.count, sums: rounded(total.sums) }
  }
}
