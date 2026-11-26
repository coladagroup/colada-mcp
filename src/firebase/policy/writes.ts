import { fail } from '../../errors.js'
import { splitPath } from './check.js'
import { APP_VIEW } from './tables.js'

export const WRITE_TOOLS = [
  'campaigns_add_timesheet_report',
  'campaigns_update_timesheet_report',
  'campaigns_create_offer',
  'campaigns_update_offer',
  'campaigns_add_budget_rows',
  'campaigns_create_lead',
  'campaigns_update_lead',
  'campaigns_update_budget_row',
  'campaigns_remove_budget_rows',
  'campaigns_update_project',
  'campaigns_create_task',
  'campaigns_update_task'
] as const

export const PROJECT_UPDATE_FIELDS = ['status', 'type', 'updatedAt'] as const

export const TASK_UPDATE_FIELDS = [
  'name',
  'summary',
  'dueDate',
  'priority',
  'assignees',
  'assignedAt',
  'mentions',
  'updatedAt',
  'updatedBy'
] as const

export const LEAD_UPDATE_FIELDS = [
  'name',
  'client',
  'contact',
  'summary',
  'closeDate',
  'status',
  'chance',
  'accountManager'
] as const

export type WriteTool = (typeof WRITE_TOOLS)[number]

export interface WriteOp {
  method: string
  path: string
  body: unknown
}

export interface WriteRule {
  id: string
  tool: WriteTool
  op: 'put' | 'patch'
  pattern: readonly string[]
  fields?: readonly string[]
}

export const OFFER_UPDATE_FIELDS = [
  'name',
  'status',
  'client',
  'person',
  'country',
  'postcode',
  'place',
  'address',
  'po',
  'eventsNum',
  'startDate',
  'endDate',
  'x_setup_start',
  'x_setup_end',
  'x_setdown_start',
  'x_setdown_end',
  'location',
  'rooms',
  'guests',
  'costCenter',
  'currency',
  'notes',
  'projectManager',
  'participants'
] as const

const OFFER_NEVER_UPDATED = [
  'owner',
  'accountManager',
  'archived',
  'externalId',
  'total',
  'allocated',
  'number',
  'createdAt',
  'uid',
  'prefix',
  'list'
]

const ID = '{id}'
const WS = ['workspaces', '{ws}']

function rule(id: string, tool: WriteTool, op: 'put' | 'patch', path: string, fields?: readonly string[]): WriteRule {
  const pattern = path.split('/')
  return { id, tool, op, pattern: path.startsWith('externalIds') ? pattern : [...WS, ...pattern], fields }
}

export const WRITE_RULES: readonly WriteRule[] = [
  rule('W01', 'campaigns_add_timesheet_report', 'put', `timesheet/${ID}`),
  rule('W02', 'campaigns_add_timesheet_report', 'put', `budgets/${ID}`),
  rule('W03', 'campaigns_update_timesheet_report', 'put', `timesheet/${ID}`),
  rule('W04', 'campaigns_update_timesheet_report', 'put', `budgets/${ID}`),
  rule('W05', 'campaigns_create_offer', 'put', 'projectCounter'),
  rule('W06', 'campaigns_create_offer', 'patch', `planner/${ID}`),
  rule('W07', 'campaigns_create_offer', 'patch', `plannerBudgets/${ID}`),
  rule('W08', 'campaigns_create_offer', 'patch', `taskBoards/${ID}`),
  rule('W09', 'campaigns_create_offer', 'patch', `taskBoards/${ID}/prefix`),
  rule('W10', 'campaigns_create_offer', 'patch', `externalIds/${ID}`),
  rule('W11', 'campaigns_update_offer', 'patch', `planner/${ID}/{field}`, [
    ...OFFER_UPDATE_FIELDS,
    'updatedAt',
    'updatedBy'
  ]),
  rule('W12', 'campaigns_update_offer', 'patch', `deals/${ID}/{field}`, ['name', 'status', 'updatedAt', 'updatedBy']),
  rule('W13', 'campaigns_add_budget_rows', 'put', `plannerBudgets/${ID}`),
  rule('W14', 'campaigns_add_budget_rows', 'patch', `planner/${ID}/{field}`, ['total', 'allocated']),
  rule('W15', 'campaigns_create_lead', 'patch', `deals/${ID}`),
  rule('W16', 'campaigns_create_lead', 'patch', `taskBoards/${ID}`),
  rule('W17', 'campaigns_create_lead', 'patch', `externalIds/${ID}`),
  rule('W18', 'campaigns_add_budget_rows', 'patch', `history/${ID}`),
  rule('W19', 'campaigns_update_budget_row', 'put', `plannerBudgets/${ID}`),
  rule('W20', 'campaigns_update_budget_row', 'patch', `planner/${ID}/{field}`, ['total', 'allocated']),
  rule('W21', 'campaigns_update_budget_row', 'patch', `history/${ID}`),
  rule('W22', 'campaigns_remove_budget_rows', 'put', `plannerBudgets/${ID}`),
  rule('W23', 'campaigns_remove_budget_rows', 'patch', `planner/${ID}/{field}`, ['total', 'allocated']),
  rule('W24', 'campaigns_remove_budget_rows', 'patch', `history/${ID}`),
  rule('W25', 'campaigns_update_lead', 'patch', `deals/${ID}/{field}`, [
    ...LEAD_UPDATE_FIELDS,
    'updatedAt',
    'updatedBy'
  ]),
  rule('W26', 'campaigns_update_lead', 'patch', `planner/${ID}/{field}`, ['name', 'status']),
  rule('W27', 'campaigns_update_project', 'patch', `projects/${ID}/{field}`, PROJECT_UPDATE_FIELDS),
  rule('W28', 'campaigns_create_task', 'put', `taskBoards/${ID}/taskCounter`),
  rule('W29', 'campaigns_create_task', 'patch', `taskBoards/${ID}/boards/${ID}/tasks/${ID}`),
  rule('W30', 'campaigns_create_task', 'patch', `externalIds/${ID}`),
  rule('W31', 'campaigns_create_task', 'put', `invoices/${ID}/${ID}/tasks`),
  rule(
    'W32',
    'campaigns_update_task',
    'patch',
    `taskBoards/${ID}/boards/${ID}/tasks/${ID}/{field}`,
    TASK_UPDATE_FIELDS
  ),
  rule('W33', 'campaigns_update_task', 'patch', `taskBoards/${ID}/boards/${ID}/tasks/${ID}`)
]

const TASK_MANAGE_PERMISSIONS = [
  'campaigns_app/tasks:manage',
  'campaigns_app/projects/tasks:manage',
  'campaigns_app/offers/tasks:manage',
  'campaigns_app/leads/tasks:manage'
] as const

export const WRITE_PERMISSIONS: Record<WriteTool, string | readonly string[]> = {
  campaigns_add_timesheet_report: 'campaigns_app/timesheet/me:manage',
  campaigns_update_timesheet_report: 'campaigns_app/timesheet/me:manage',
  campaigns_create_offer: 'campaigns_app/offers:manage',
  campaigns_update_offer: 'campaigns_app/offers/settings:manage',
  campaigns_add_budget_rows: 'campaigns_app/offers/budget:manage',
  campaigns_create_lead: 'campaigns_app/leads:manage',
  campaigns_update_lead: 'campaigns_app/leads:manage',
  campaigns_update_budget_row: 'campaigns_app/offers/budget:manage',
  campaigns_remove_budget_rows: 'campaigns_app/offers/budget:manage',
  campaigns_update_project: 'campaigns_app/projects/settings:manage',
  campaigns_create_task: TASK_MANAGE_PERMISSIONS,
  campaigns_update_task: TASK_MANAGE_PERMISSIONS
}

export const PERSONAL_INPUT_FIELDS: Record<WriteTool, readonly string[]> = {
  campaigns_add_timesheet_report: ['description'],
  campaigns_update_timesheet_report: ['description'],
  campaigns_create_offer: ['person', 'participants', 'notes'],
  campaigns_update_offer: ['person', 'participants', 'notes'],
  campaigns_add_budget_rows: [],
  campaigns_create_lead: ['name', 'contact', 'summary'],
  campaigns_update_lead: ['name', 'contact', 'summary'],
  campaigns_update_budget_row: [],
  campaigns_remove_budget_rows: [],
  campaigns_update_project: [],
  campaigns_create_task: ['summary', 'assignees'],
  campaigns_update_task: ['summary', 'assignees']
}

export const IDENTITY_INPUT_FIELDS = [
  'owner',
  'accountManager',
  'updatedBy',
  'createdBy',
  'createdAt',
  'updatedAt',
  'uid',
  'number'
] as const

const IDENTITY_BODY_FIELDS = ['owner', 'accountManager', 'updatedBy', 'createdBy']

interface Entry {
  op: 'put' | 'patch'
  segments: string[]
  value: unknown
}

export interface WriteContext {
  workspace: string
  uid: string
  checkedUsers?: ReadonlySet<string>
}

export type WriteRefusal = 'X1' | 'X2' | 'X3' | 'X4' | 'X5' | 'X6' | 'X7' | 'X8' | 'X9' | 'X10' | 'shape' | 'table'

export function writeRefusal(tool: WriteTool, op: WriteOp, ctx: WriteContext): WriteRefusal | null {
  if (op.method !== 'PUT' && op.method !== 'PATCH') return 'X4'
  const entries = entriesOf(op)
  if (entries === null) return 'shape'
  if (entries.some((entry) => entry.value === null) && !isTaskMove(tool, entries)) return 'X5'
  for (const entry of entries) {
    const reason = deniedBy(tool, entry, ctx)
    if (reason) return reason
    if (!WRITE_RULES.some((candidate) => candidate.tool === tool && matches(candidate, entry, ctx))) return 'table'
  }
  return null
}

export interface PlannedWrite {
  method: string
  path: string
}

export function plannedRefusal(tool: WriteTool, planned: PlannedWrite, workspace: string): WriteRefusal | null {
  if (planned.method !== 'PUT' && planned.method !== 'PATCH') return 'X4'
  const entry: Entry = {
    op: planned.method === 'PUT' ? 'put' : 'patch',
    segments: splitPath(planned.path),
    value: null
  }
  const reason = pathDenied(tool, entry, workspace)
  if (reason) return reason
  const ctx = { workspace, uid: '' }
  return WRITE_RULES.some((candidate) => candidate.tool === tool && matches(candidate, entry, ctx)) ? null : 'table'
}

export function checkPlannedWrite(tool: WriteTool, planned: PlannedWrite, workspace: string): void {
  if (plannedRefusal(tool, planned, workspace) !== null) {
    throw fail.writePathNotAllowed(planned.method, planned.path, tool)
  }
}

export function checkFirebaseWrite(tool: WriteTool, op: WriteOp, ctx: WriteContext): void {
  if (writeRefusal(tool, op, ctx) !== null) {
    throw fail.writePathNotAllowed(op.method, op.path === '' ? '/' : op.path, tool)
  }
}

export function checkWritePermission(tool: WriteTool, permissions: ReadonlySet<string>, workspace: string): void {
  for (const required of [APP_VIEW, WRITE_PERMISSIONS[tool]]) {
    const anyOf = typeof required === 'string' ? [required] : required
    if (!anyOf.some((permission) => permissions.has(permission))) {
      throw fail.writeMissingPermission(anyOf.join(' or '), workspace, tool)
    }
  }
}

const TASK_SOURCE_PERMISSIONS = {
  projects: 'campaigns_app/projects/tasks:manage',
  planner: 'campaigns_app/offers/tasks:manage',
  lead: 'campaigns_app/leads/tasks:manage'
} as const

export type TaskSourceKind = keyof typeof TASK_SOURCE_PERMISSIONS

export function checkTaskSourcePermission(
  tool: WriteTool,
  kinds: readonly TaskSourceKind[],
  permissions: ReadonlySet<string>,
  workspace: string
): void {
  const anyOf = [...kinds.map((kind) => TASK_SOURCE_PERMISSIONS[kind]), 'campaigns_app/tasks:manage']
  if (!anyOf.some((permission) => permissions.has(permission))) {
    throw fail.writeMissingPermission(anyOf.join(' or '), workspace, tool)
  }
}

export function checkPersonalInput(tool: WriteTool, input: object, allowPersonalData: boolean) {
  if (allowPersonalData) return
  const field = PERSONAL_INPUT_FIELDS[tool].find((name) => (input as Record<string, unknown>)[name] !== undefined)
  if (field) throw fail.writePersonalField(field)
}

function entriesOf(op: WriteOp): Entry[] | null {
  const base = op.path === '' ? [] : splitPath(op.path)
  if (op.method === 'PUT') {
    if (base.length === 0) return null
    return [{ op: 'put', segments: base, value: op.body }]
  }
  if (!isPlainObject(op.body) || Object.keys(op.body).length === 0) return null
  return Object.entries(op.body).map(([key, value]) => ({
    op: 'patch' as const,
    segments: [...base, ...splitPath(key)],
    value
  }))
}

function pathDenied(tool: WriteTool, entry: Entry, workspace: string): WriteRefusal | null {
  const { segments } = entry
  const [root, ws, node] = segments
  if (root === 'workspaces' && node === 'projects' && !isProjectFieldUpdate(tool, entry)) return 'X1'
  if (root === 'workspaces' && node === 'secrets') return 'X2'
  if (root === 'workspaces' && node === 'deals' && segments[4] === 'costCenter') return 'X3'
  if (root === 'workspaces' && ws !== workspace) return 'X8'
  if (root === 'externalIds' && segments.length !== 2) return 'X9'
  return null
}

function isProjectFieldUpdate(tool: WriteTool, { op, segments }: Entry): boolean {
  return (
    tool === 'campaigns_update_project' &&
    op === 'patch' &&
    segments.length === 5 &&
    (PROJECT_UPDATE_FIELDS as readonly string[]).includes(segments[4] ?? '')
  )
}

function isTaskNode(segments: readonly string[]): boolean {
  return (
    segments[0] === 'workspaces' && segments[2] === 'taskBoards' && segments[4] === 'boards' && segments[6] === 'tasks'
  )
}

function isTaskMove(tool: WriteTool, entries: Entry[]): boolean {
  if (tool !== 'campaigns_update_task' || entries.length !== 2) return false
  const [removed, added] = [entries.find((e) => e.value === null), entries.find((e) => e.value !== null)]
  if (!removed || !added || !isPlainObject(added.value)) return false
  const same = (index: number) => removed.segments[index] === added.segments[index]
  return (
    [removed, added].every((entry) => entry.segments.length === 8 && isTaskNode(entry.segments)) &&
    same(1) &&
    same(3) &&
    !same(5) &&
    added.segments[7] === added.value.uid
  )
}

function deniedBy(tool: WriteTool, entry: Entry, ctx: WriteContext): WriteRefusal | null {
  const { segments, value } = entry
  const [root, , node] = segments
  const byPath = pathDenied(tool, entry, ctx.workspace)
  if (byPath) return byPath
  if (root === 'workspaces' && node === 'deals' && segments.length === 4 && isPlainObject(value)) {
    if ('costCenter' in value) return 'X3'
  }
  const taskMove = tool === 'campaigns_update_task' && segments.length === 8 && isTaskNode(segments)
  if (value === null && taskMove) return null
  if (value === null || value === undefined) return 'X5'
  if (entry.op === 'put' && isEmpty(value)) return 'X6'
  const last = segments[segments.length - 1] ?? ''
  const onDeal = root === 'workspaces' && node === 'deals'
  const checked = (given: unknown) => typeof given === 'string' && (ctx.checkedUsers?.has(given) ?? false)
  const identityAllowed = (field: string, given: unknown) =>
    given === ctx.uid ||
    (onDeal && field === 'accountManager' && checked(given)) ||
    (taskMove && field === 'owner' && checked(given))
  if (IDENTITY_BODY_FIELDS.includes(last) && !identityAllowed(last, value)) return 'X7'
  if (
    isPlainObject(value) &&
    IDENTITY_BODY_FIELDS.some((field) => field in value && !identityAllowed(field, value[field]))
  ) {
    return 'X7'
  }
  if (root === 'externalIds') {
    if (!isPlainObject(value)) return 'X9'
    const keys = Object.keys(value).sort()
    if (keys.join(',') !== 'source,workspace' || typeof value.source !== 'string') return 'X9'
    if (value.workspace !== ctx.workspace) return 'X9'
  }
  if (tool === 'campaigns_update_offer' && node === 'planner' && OFFER_NEVER_UPDATED.includes(segments[4] ?? '')) {
    return 'X10'
  }
  return null
}

function matches(candidate: WriteRule, entry: Entry, ctx: WriteContext): boolean {
  if (candidate.op !== entry.op || candidate.pattern.length !== entry.segments.length) return false
  return candidate.pattern.every((part, index) => {
    const segment = entry.segments[index] ?? ''
    if (part === '{ws}') return segment === ctx.workspace
    if (part === ID) return true
    if (part === '{field}') return candidate.fields?.includes(segment) ?? false
    return part === segment
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0
  return isPlainObject(value) && Object.keys(value).length === 0
}
