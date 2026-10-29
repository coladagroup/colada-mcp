import { messages, ToolError } from '../../errors.js'
import { APP_VIEW, CAMPAIGNS_RULES, type NodeRule, REPORTS_VIEW, type Store, TIMESHEET_ME_VIEW } from './tables.js'

export type TimesheetMode = 'all' | 'own'

export interface CheckedPath {
  rule: NodeRule
  segments: string[]
  rest: string[]
  timesheetMode: TimesheetMode | null
}

const MAX_PATH_BYTES = 768
const FORBIDDEN_CHARACTERS = /[?#[\]$%\\]/

function hasControlCharacter(segment: string): boolean {
  return [...segment].some((character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || code === 0x7f
  })
}

export function splitPath(path: string): string[] {
  const refuse = (reason: string) => new ToolError(messages.firebasePath(path, reason))
  if (path === '') throw refuse('it is empty; the workspace root cannot be read')
  if (Buffer.byteLength(path) > MAX_PATH_BYTES) throw refuse('it is longer than 768 bytes')
  const segments = path.split('/')
  for (const segment of segments) {
    if (segment === '') throw refuse('it has an empty segment (leading, trailing or double "/")')
    if (segment === '.' || segment === '..') throw refuse('"." and ".." are not allowed')
    if (FORBIDDEN_CHARACTERS.test(segment) || hasControlCharacter(segment))
      throw refuse('it has one of ? # [ ] $ % \\ or a control character')
  }
  return segments
}

export interface FirebaseTarget {
  rule: NodeRule
  segments: string[]
  rest: string[]
}

export function checkFirebaseTarget(store: Store, path: string, allowPersonalData: boolean): FirebaseTarget {
  const segments = splitPath(path)
  const [node, ...rest] = segments
  const rule = CAMPAIGNS_RULES.find((candidate) => candidate.store === store && candidate.node === node)
  if (!rule) throw new ToolError(messages.firebasePath(path, `"${node}" is not on the ${store} allowlist`))
  if (store === 'firestore' && rest.length > 1) {
    throw new ToolError(messages.firebasePath(path, 'only a collection or one document of it can be read'))
  }
  if ((rule.link?.by === 'field' || rule.ownRows) && rest.length > 1) {
    throw new ToolError(messages.firebasePath(path, `read the whole record ${node}/<id>, not a part of it`))
  }
  if (rule.group === 'personal' && !allowPersonalData) throw new ToolError(messages.firebasePersonalNode(rule.node))
  return { rule, segments, rest }
}

export function checkFirebaseAccess(
  target: FirebaseTarget,
  permissions: ReadonlySet<string>,
  workspace: string
): CheckedPath {
  const { rule } = target
  if (!permissions.has(APP_VIEW)) {
    throw new ToolError(messages.firebaseMissingPermission([APP_VIEW], workspace, rule.node))
  }
  if (!rule.permissions.some((permission) => permissions.has(permission))) {
    throw new ToolError(messages.firebaseMissingPermission(rule.permissions, workspace, rule.node))
  }
  return { ...target, timesheetMode: rule.ownRows ? timesheetMode(permissions) : null }
}

function timesheetMode(permissions: ReadonlySet<string>): TimesheetMode {
  if (permissions.has(REPORTS_VIEW)) return 'all'
  return permissions.has(TIMESHEET_ME_VIEW) ? 'own' : 'all'
}
