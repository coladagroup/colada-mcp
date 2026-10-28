import { messages, ToolError } from '../../errors.js'
import type { TimesheetMode } from './check.js'
import type { NodeRule, Store } from './tables.js'

const ROLE_PRIORITY = [
  'campaigns_app_super_admin',
  'campaigns_app_admin',
  'campaigns_app_finance_manager',
  'campaigns_app_controller',
  'campaigns_app_finance_approver',
  'campaigns_app_planner',
  'campaigns_app_restricted_planner',
  'campaigns_app_requester',
  'campaigns_app_approver',
  'campaigns_app_service_manager',
  'campaigns_app_service_employee',
  'campaigns_app_speaker',
  'campaigns_app_timesheet_reporter'
] as const

const LOBBY_ROLES = new Set(['campaigns_app_requester', 'campaigns_app_speaker'])

export function campaignsRole(roles: readonly string[]): string {
  return ROLE_PRIORITY.find((role) => roles.includes(role)) ?? ''
}

function assigned(uid: string, users: unknown): boolean {
  if (Array.isArray(users)) return users.includes(uid)
  if (users !== null && typeof users === 'object') return Object.values(users).includes(uid)
  return users === uid
}

export function isHiddenProject(project: unknown, uid: string, role: string): boolean {
  if (project === null || typeof project !== 'object') return false
  const p = project as Record<string, unknown>
  if (
    LOBBY_ROLES.has(role) &&
    !(assigned(uid, p.deputies) || assigned(uid, p.requesters) || uid === p.accountManager)
  ) {
    return true
  }
  return Boolean(p.isPrivate) && !(assigned(uid, p.deputies) || uid === p.accountManager || uid === p.owner)
}

export function hiddenProjectIds(metas: Array<unknown>, uid: string, role: string): Set<string> {
  const hidden = new Set<string>()
  for (const records of metas) {
    if (records === null || typeof records !== 'object') continue
    for (const [id, project] of Object.entries(records)) if (isHiddenProject(project, uid, role)) hidden.add(id)
  }
  return hidden
}

export interface RowContext {
  store: Store
  path: string
  uid: string
  timesheetMode: TimesheetMode | null
  hidden: ReadonlySet<string>
}

export interface RowResult {
  value: unknown
  removedRecords: number
}

export function needsHiddenProjects(rule: NodeRule): boolean {
  return rule.link !== undefined
}

export function applyRowRules(rule: NodeRule, rest: readonly string[], value: unknown, ctx: RowContext): RowResult {
  const notFound = () => new ToolError(messages.firebaseNotFound(ctx.store, ctx.path))
  const ownOnly = rule.ownRows === true && ctx.timesheetMode === 'own'
  const keyHidden = rule.link?.by === 'self' || rule.link?.by === 'key'
  const recordHidden = (record: unknown) => {
    if (record === null || typeof record !== 'object') return false
    const r = record as Record<string, unknown>
    if (ownOnly && r.owner !== ctx.uid) return true
    if (rule.link?.by !== 'field') return false
    return rule.link.fields.some((field) => typeof r[field] === 'string' && ctx.hidden.has(r[field] as string))
  }

  if (rest.length > 0) {
    if (keyHidden && ctx.hidden.has(rest[0] ?? '')) throw notFound()
    if (rest.length === 1 && value !== null && recordHidden(value)) throw notFound()
    return { value, removedRecords: 0 }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { value, removedRecords: 0 }
  const result: Record<string, unknown> = {}
  let removedRecords = 0
  for (const [key, record] of Object.entries(value)) {
    if ((keyHidden && ctx.hidden.has(key)) || recordHidden(record)) removedRecords++
    else result[key] = record
  }
  return { value: result, removedRecords }
}
