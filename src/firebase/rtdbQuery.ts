import { messages, ToolError } from '../errors.js'
import type { Scalar } from './localOps.js'

export interface RtdbQuery {
  shallow?: boolean
  orderBy?: string
  equalTo?: Scalar
  startAt?: Scalar
  endAt?: Scalar
  limitToFirst?: number
  limitToLast?: number
}

export const RTDB_INDEXES: Readonly<Record<string, readonly string[]>> = {
  timesheet: ['owner', 'project'],
  projects: ['account', 'owner', 'archived', 'guestsEventId'],
  activities: ['source'],
  history: ['source'],
  tasks: ['source']
}

const ORDER_BY = /^(\$key|\$value|[A-Za-z0-9_-]{1,100})$/

export function indexesOf(node: string): string {
  return ['$key', ...(RTDB_INDEXES[node] ?? [])].join(', ')
}

export function rtdbQueryString(query: RtdbQuery): string {
  const filters = (['equalTo', 'startAt', 'endAt', 'limitToFirst', 'limitToLast'] as const).filter(
    (name) => query[name] !== undefined
  )
  if (query.shallow) {
    if (query.orderBy !== undefined || filters.length) {
      throw new ToolError(messages.firebaseQuery('shallow cannot be combined with other options'))
    }
    return 'shallow=true'
  }
  if (filters.length && query.orderBy === undefined) {
    throw new ToolError(messages.firebaseQuery(`${filters.join(', ')} need orderBy`))
  }
  if (query.limitToFirst !== undefined && query.limitToLast !== undefined) {
    throw new ToolError(messages.firebaseQuery('use limitToFirst or limitToLast, not both'))
  }
  if (query.orderBy !== undefined && !ORDER_BY.test(query.orderBy)) {
    throw new ToolError(messages.firebaseQuery(`orderBy "${query.orderBy}" must be $key, $value or a child name`))
  }
  const parts: string[] = []
  if (query.orderBy !== undefined) parts.push(`orderBy=${encodeURIComponent(JSON.stringify(query.orderBy))}`)
  for (const name of ['equalTo', 'startAt', 'endAt'] as const) {
    if (query[name] !== undefined) parts.push(`${name}=${encodeURIComponent(JSON.stringify(query[name]))}`)
  }
  for (const name of ['limitToFirst', 'limitToLast'] as const) {
    if (query[name] !== undefined) parts.push(`${name}=${query[name]}`)
  }
  return parts.join('&')
}
