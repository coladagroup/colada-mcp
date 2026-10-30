import { messages, ToolError } from '../../errors.js'
import { splitPath } from './check.js'
import { APP_VIEW } from './tables.js'

export const WRITE_TOOLS = [
  'campaigns_add_timesheet_report',
  'campaigns_update_timesheet_report',
  'campaigns_create_offer',
  'campaigns_update_offer',
  'campaigns_add_budget_rows',
  'campaigns_create_lead'
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
  rule('W17', 'campaigns_create_lead', 'patch', `externalIds/${ID}`)
]

export const WRITE_PERMISSIONS: Record<WriteTool, string> = {
  campaigns_add_timesheet_report: 'campaigns_app/timesheet/me:manage',
  campaigns_update_timesheet_report: 'campaigns_app/timesheet/me:manage',
  campaigns_create_offer: 'campaigns_app/offers:manage',
  campaigns_update_offer: 'campaigns_app/offers/settings:manage',
  campaigns_add_budget_rows: 'campaigns_app/offers/budget:manage',
  campaigns_create_lead: 'campaigns_app/leads:manage'
}

export const PERSONAL_INPUT_FIELDS: Record<WriteTool, readonly string[]> = {
  campaigns_add_timesheet_report: ['description'],
  campaigns_update_timesheet_report: ['description'],
  campaigns_create_offer: ['person', 'participants', 'notes'],
  campaigns_update_offer: ['person', 'participants', 'notes'],
  campaigns_add_budget_rows: [],
  campaigns_create_lead: ['name', 'contact', 'summary']
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
}

export type WriteRefusal = 'X1' | 'X2' | 'X3' | 'X4' | 'X5' | 'X6' | 'X7' | 'X8' | 'X9' | 'X10' | 'shape' | 'table'

export function writeRefusal(tool: WriteTool, op: WriteOp, ctx: WriteContext): WriteRefusal | null {
  if (op.method !== 'PUT' && op.method !== 'PATCH') return 'X4'
  const entries = entriesOf(op)
  if (entries === null) return 'shape'
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
  const reason = pathDenied(entry.segments, workspace)
  if (reason) return reason
  const ctx = { workspace, uid: '' }
  return WRITE_RULES.some((candidate) => candidate.tool === tool && matches(candidate, entry, ctx)) ? null : 'table'
}

export function checkPlannedWrite(tool: WriteTool, planned: PlannedWrite, workspace: string): void {
  if (plannedRefusal(tool, planned, workspace) !== null) {
    throw new ToolError(messages.writePathNotAllowed(planned.method, planned.path, tool))
  }
}

export function checkFirebaseWrite(tool: WriteTool, op: WriteOp, ctx: WriteContext): void {
  if (writeRefusal(tool, op, ctx) !== null) {
    throw new ToolError(messages.writePathNotAllowed(op.method, op.path === '' ? '/' : op.path, tool))
  }
}

export function checkWritePermission(tool: WriteTool, permissions: ReadonlySet<string>, workspace: string): void {
  for (const permission of [APP_VIEW, WRITE_PERMISSIONS[tool]]) {
    if (!permissions.has(permission)) {
      throw new ToolError(messages.writeMissingPermission(permission, workspace, tool))
    }
  }
}

export function checkPersonalInput(tool: WriteTool, input: object, allowPersonalData: boolean) {
  if (allowPersonalData) return
  const field = PERSONAL_INPUT_FIELDS[tool].find((name) => (input as Record<string, unknown>)[name] !== undefined)
  if (field) throw new ToolError(messages.writePersonalField(field))
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

function pathDenied(segments: readonly string[], workspace: string): WriteRefusal | null {
  const [root, ws, node] = segments
  if (root === 'workspaces' && node === 'projects') return 'X1'
  if (root === 'workspaces' && node === 'secrets') return 'X2'
  if (root === 'workspaces' && node === 'deals' && segments[4] === 'costCenter') return 'X3'
  if (root === 'workspaces' && ws !== workspace) return 'X8'
  if (root === 'externalIds' && segments.length !== 2) return 'X9'
  return null
}

function deniedBy(tool: WriteTool, entry: Entry, ctx: WriteContext): WriteRefusal | null {
  const { segments, value } = entry
  const [root, , node] = segments
  const byPath = pathDenied(segments, ctx.workspace)
  if (byPath) return byPath
  if (root === 'workspaces' && node === 'deals' && segments.length === 4 && isPlainObject(value)) {
    if ('costCenter' in value) return 'X3'
  }
  if (value === null || value === undefined) return 'X5'
  if (entry.op === 'put' && isEmpty(value)) return 'X6'
  const last = segments[segments.length - 1] ?? ''
  if (IDENTITY_BODY_FIELDS.includes(last) && value !== ctx.uid) return 'X7'
  if (isPlainObject(value) && IDENTITY_BODY_FIELDS.some((field) => field in value && value[field] !== ctx.uid)) {
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
