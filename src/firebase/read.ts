import type { App } from '../app.js'
import { messages, ToolError } from '../errors.js'
import { MAX_RESPONSE_BYTES } from '../policy/index.js'
import type { FirebaseToolContext } from '../tools/run.js'
import { openRealm } from '../tools/run.js'
import {
  CHF_CURRENCY,
  calculateAllocated,
  calculateReportsTotal,
  calculateTotal,
  type ExchangeRates,
  flattenBudget,
  parseBudgetData
} from './campaigns/budgetMath.js'
import { firestoreFieldPath, fromFirestoreFields } from './firestoreValues.js'
import type { FirebaseResponse } from './http.js'
import { applyLocalOps, fieldsUsed, hasLocalOps, type LocalOps } from './localOps.js'
import {
  type CheckedPath,
  type FirebaseTarget as CheckedTarget,
  checkFirebaseAccess,
  checkFirebaseTarget,
  splitPath
} from './policy/check.js'
import { assertUsable, redact } from './policy/redact.js'
import { applyRowRules, campaignsRole, hiddenProjectIds } from './policy/rows.js'
import type { NodeRule, ProjectKind, Store } from './policy/tables.js'
import { indexesOf, type RtdbQuery, rtdbQueryString } from './rtdbQuery.js'
import type { FirebaseAccess, FirebaseAppName, FirebaseSessions } from './session.js'

export interface FirebaseTarget {
  realm?: string
  workspace?: string
  app: FirebaseAppName
  path: string
}

export interface RtdbInput extends FirebaseTarget, RtdbQuery, LocalOps {}

export interface FirestoreInput extends FirebaseTarget {
  pageSize?: number
  pageToken?: string
  fields?: string[]
}

interface Reader {
  workspace: string
  access: () => Promise<FirebaseAccess>
  send: (
    request: (access: FirebaseAccess) => Promise<FirebaseResponse>,
    store: Store,
    path: string
  ) => Promise<FirebaseResponse>
}

const FIRESTORE_HOST = 'https://firestore.googleapis.com/v1'
const DEFAULT_PAGE_SIZE = 50

async function openReader(app: App, ctx: FirebaseToolContext, target: FirebaseTarget): Promise<Reader> {
  const { directory, firebase } = await openRealm(app, ctx, target.realm)
  const workspace = await directory.resolve(target.workspace, ctx.state)
  ctx.workspace = workspace
  const access = () => firebase.access(workspace.id, target.app, ctx.state)
  return { workspace: workspace.id, access, send: sender(firebase, workspace.id, target.app, access, ctx) }
}

function sender(
  firebase: FirebaseSessions,
  workspace: string,
  appName: FirebaseAppName,
  access: () => Promise<FirebaseAccess>,
  ctx: FirebaseToolContext
): Reader['send'] {
  return async (request, store, path) => {
    const used = await access()
    let response = await request(used)
    ctx.state.httpStatus = response.status
    if (response.status === 401) {
      firebase.drop(workspace, appName)
      const fresh = await access()
      if (!sameAccess(used, fresh)) throw new ToolError(messages.firebaseAccessChanged())
      response = await request(fresh)
      ctx.state.httpStatus = response.status
    }
    if (response.status === 401 || response.status === 403) throw new ToolError(messages.firebaseRefused(path))
    if (response.status === 404) throw new ToolError(messages.firebaseNotFound(store, path))
    if (response.status === 400) {
      throw new ToolError(messages.firebaseQuery(upstreamText(response) ?? 'refused by Firebase (400)'))
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ToolError(messages.firebaseFailed(store, path, response.status))
    }
    return response
  }
}

function sameAccess(a: FirebaseAccess, b: FirebaseAccess): boolean {
  const sorted = (values: Iterable<string>) => JSON.stringify([...values].sort())
  return a.uid === b.uid && sorted(a.roles) === sorted(b.roles) && sorted(a.permissions) === sorted(b.permissions)
}

function upstreamText(response: FirebaseResponse): string | null {
  const body = response.body as { error?: unknown } | null
  const error = body?.error
  if (typeof error === 'string') return error.slice(0, 300)
  const message = (error as { message?: unknown } | undefined)?.message
  return typeof message === 'string' ? message.slice(0, 300) : (response.errorText?.slice(0, 300) ?? null)
}

function rtdbUrl(access: FirebaseAccess, workspace: string, segments: readonly string[], query: string): string {
  const path = ['workspaces', workspace, ...segments].map(encodeURIComponent).join('/')
  const auth = `auth=${encodeURIComponent(access.idToken)}`
  return `https://${access.config.databaseHost}/${path}.json?${query ? `${query}&` : ''}${auth}`
}

function rtdbRequest(
  app: App,
  reader: Reader,
  segments: readonly string[],
  query: string,
  node: string,
  shown: string,
  tooLarge: () => string = () => messages.firebaseTooLarge('rtdb', shown, indexesOf(node))
) {
  return (access: FirebaseAccess) =>
    app.firebaseHttp.request({
      url: rtdbUrl(access, reader.workspace, segments, query),
      store: 'rtdb',
      path: shown,
      tooLarge
    })
}

function linkedKinds(rule: NodeRule): ProjectKind[] {
  if (!rule.link) return []
  if (rule.link.by === 'self') return [rule.link.kind]
  if (rule.link.by === 'key') return [...rule.link.kinds]
  return ['projects', 'planner']
}

const hiddenByAccess = new WeakMap<FirebaseAccess, Map<ProjectKind, Promise<Set<string>>>>()

async function hiddenProjects(app: App, reader: Reader, rule: NodeRule): Promise<Set<string>> {
  const kinds = linkedKinds(rule)
  if (kinds.length === 0) return new Set()
  const access = await reader.access()
  const byKind = hiddenByAccess.get(access) ?? new Map<ProjectKind, Promise<Set<string>>>()
  hiddenByAccess.set(access, byKind)
  const sets = await Promise.all(
    kinds.map((kind) => {
      const cached = byKind.get(kind)
      if (cached) return cached
      const tooLarge = () => messages.firebaseHiddenSetTooLarge(kind, rule.node)
      const pending = reader
        .send(rtdbRequest(app, reader, [kind], '', kind, kind, tooLarge), 'rtdb', kind)
        .then((response) => hiddenProjectIds([response.body], access.uid, campaignsRole(access.roles)))
      pending.catch(() => byKind.delete(kind))
      byKind.set(kind, pending)
      return pending
    })
  )
  return new Set(sets.flatMap((set) => [...set]))
}

function isRecords(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => item !== null && typeof item === 'object')
  )
}

function finish(result: Record<string, unknown>, removed: Set<string>, removedRecords: number) {
  const output = {
    ...result,
    removedFields: [...removed].sort(),
    ...(removedRecords > 0 ? { removedRecords } : {})
  }
  if (Buffer.byteLength(JSON.stringify(output)) > MAX_RESPONSE_BYTES) {
    throw new ToolError(messages.firebaseResultTooLarge())
  }
  return output
}

function assertOpsUsable(checked: CheckedTarget, ops: LocalOps, allowPersonalData: boolean) {
  for (const { field, option } of fieldsUsed(ops)) assertUsable(field, option, checked.rule, allowPersonalData)
}

export async function readRtdb(app: App, ctx: FirebaseToolContext, input: RtdbInput) {
  const allowPersonalData = app.deps.allowPersonalData
  const target = checkFirebaseTarget('rtdb', input.path, allowPersonalData)
  const { rule, rest } = target
  const ops: LocalOps = { where: input.where, fields: input.fields, groupBy: input.groupBy, sum: input.sum }
  if (input.shallow && hasLocalOps(ops)) {
    throw new ToolError(messages.firebaseQuery('shallow cannot be combined with where, fields, groupBy or sum'))
  }
  assertOpsUsable(target, ops, allowPersonalData)
  const query: RtdbQuery = {
    shallow: input.shallow,
    orderBy: input.orderBy,
    equalTo: input.equalTo,
    startAt: input.startAt,
    endAt: input.endAt,
    limitToFirst: input.limitToFirst,
    limitToLast: input.limitToLast
  }
  if (input.shallow && rule.link?.by === 'field') throw new ToolError(messages.firebaseNoShallow(rule.node))
  const hasQuery = Object.values(query).some((value) => value !== undefined && value !== false)
  if ((rule.link?.by === 'field' || rule.ownRows) && rest.length === 1 && hasQuery) {
    throw new ToolError(messages.firebaseQuery(`orderBy, filters and limits work on ${rule.node}, not on one record`))
  }
  if (input.orderBy !== undefined && input.orderBy !== '$key' && input.orderBy !== '$value') {
    assertUsable(input.orderBy, 'orderBy', rule, allowPersonalData)
  }
  const ownerQuery = rtdbQueryString(query)
  const reader = await openReader(app, ctx, input)
  const access = await reader.access()
  const checked = checkFirebaseAccess(target, access.permissions, reader.workspace)
  let queryString: string
  if (checked.timesheetMode === 'own' && rest.length === 0) {
    if (hasQuery) {
      throw new ToolError(messages.firebaseOwnRowsOnly())
    }
    queryString = rtdbQueryString({ orderBy: 'owner', equalTo: access.uid })
  } else {
    queryString = ownerQuery
  }
  const hidden = await hiddenProjects(app, reader, rule)
  const response = await reader
    .send(rtdbRequest(app, reader, checked.segments, queryString, rule.node, input.path), 'rtdb', input.path)
    .catch((err: Error) => {
      if (/Index not defined/.test(err.message) && input.orderBy) {
        throw new ToolError(messages.firebaseNoIndex(input.orderBy, rule.node, indexesOf(rule.node)))
      }
      throw err
    })
  const rows = applyRowRules(rule, rest, response.body, {
    store: 'rtdb',
    path: input.path,
    uid: access.uid,
    timesheetMode: checked.timesheetMode,
    hidden
  })
  const { value, removed } = redact(rows.value, rest, rule, allowPersonalData)
  let data: unknown = value
  if (hasLocalOps(ops)) {
    if (value === null) data = applyLocalOps({}, ops)
    else if (!isRecords(value)) throw new ToolError(messages.firebaseNotRecords(localOptionName(ops), input.path))
    else data = applyLocalOps(value, ops)
  } else if (isRecords(value)) {
    data = Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  }
  const count = data !== null && typeof data === 'object' && !('groups' in data) ? Object.keys(data).length : undefined
  const body =
    data !== null && typeof data === 'object' && 'groups' in data
      ? { ...(data as Record<string, unknown>) }
      : { ...(count === undefined ? {} : { count }), data }
  return finish({ app: input.app, store: 'rtdb', path: input.path, ...body }, removed, rows.removedRecords)
}

function localOptionName(ops: LocalOps): string {
  if (ops.where?.length) return 'where'
  if (ops.fields?.length) return 'fields'
  return ops.groupBy?.length ? 'groupBy' : 'sum'
}

interface FirestoreDocument {
  name?: string
  fields?: unknown
  updateTime?: string
}

export async function readFirestore(app: App, ctx: FirebaseToolContext, input: FirestoreInput) {
  const allowPersonalData = app.deps.allowPersonalData
  const target = checkFirebaseTarget('firestore', input.path, allowPersonalData)
  const { rule, rest } = target
  const document = rest.length === 1
  if (document && (input.pageSize !== undefined || input.pageToken !== undefined)) {
    throw new ToolError(messages.firebaseQuery('pageSize and pageToken work on a collection, not on one document'))
  }
  for (const field of input.fields ?? []) assertUsable(field, 'fields', rule, allowPersonalData)
  const params = new URLSearchParams()
  if (!document) params.set('pageSize', String(input.pageSize ?? DEFAULT_PAGE_SIZE))
  if (!document && input.pageToken) params.set('pageToken', input.pageToken)
  const linkFields = rule.link?.by === 'field' ? rule.link.fields : []
  const masked = input.fields?.length ? input.fields : []
  const addedLinks = masked.length ? linkFields.filter((field) => !masked.includes(field)) : []
  for (const field of [...masked, ...addedLinks]) params.append('mask.fieldPaths', firestoreFieldPath(field))
  const reader = await openReader(app, ctx, input)
  const access = await reader.access()
  const checked = checkFirebaseAccess(target, access.permissions, reader.workspace)
  const hidden = await hiddenProjects(app, reader, rule)
  const path = ['workspaces', reader.workspace, ...checked.segments].map(encodeURIComponent).join('/')
  const response = await reader.send(
    (current) =>
      app.firebaseHttp.request({
        url: `${FIRESTORE_HOST}/projects/${current.config.projectId}/databases/(default)/documents/${path}${params.size ? `?${params}` : ''}`,
        bearer: current.idToken,
        store: 'firestore',
        path: input.path,
        tooLarge: () => messages.firebaseTooLarge('firestore', input.path, 'pageSize')
      }),
    'firestore',
    input.path
  )
  const rowContext = {
    store: 'firestore' as const,
    path: input.path,
    uid: access.uid,
    timesheetMode: checked.timesheetMode,
    hidden
  }
  const removed = new Set<string>()
  const clean = (id: string, fields: unknown) => {
    const data = fromFirestoreFields(fields)
    for (const field of addedLinks) delete data[field]
    const result = redact(data, [id], rule, allowPersonalData)
    for (const name of result.removed) removed.add(name)
    return result.value
  }
  const base = { app: input.app, store: 'firestore', path: input.path }
  if (document) {
    const doc = response.body as FirestoreDocument
    const id = rest[0] ?? ''
    applyRowRules(rule, rest, fromFirestoreFields(doc.fields), rowContext)
    return finish({ ...base, id, updateTime: doc.updateTime, data: clean(id, doc.fields) }, removed, 0)
  }
  const body = (response.body ?? {}) as { documents?: FirestoreDocument[]; nextPageToken?: string }
  const docs = (body.documents ?? []).map((doc) => ({
    id: (doc.name ?? '').split('/').pop() ?? '',
    updateTime: doc.updateTime,
    fields: doc.fields
  }))
  const kept = applyRowRules(
    rule,
    [],
    Object.fromEntries(docs.map((doc) => [doc.id, fromFirestoreFields(doc.fields)])),
    rowContext
  )
  const keptIds = new Set(Object.keys(kept.value as Record<string, unknown>))
  const documents = docs
    .filter((doc) => keptIds.has(doc.id))
    .map((doc) => ({ id: doc.id, updateTime: doc.updateTime, data: clean(doc.id, doc.fields) }))
  return finish(
    { ...base, documents, ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}) },
    removed,
    kept.removedRecords
  )
}

export interface BudgetInput {
  realm?: string
  workspace?: string
  kind: ProjectKind
  id: string
  rows?: boolean
}

const BUDGET_NODE: Record<ProjectKind, string> = { projects: 'budgets', planner: 'plannerBudgets' }

function exchangeRatesOf(value: unknown): ExchangeRates {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, number>
}

export async function readBudget(app: App, ctx: FirebaseToolContext, input: BudgetInput) {
  if (splitPath(input.id).length !== 1) {
    throw new ToolError(messages.firebasePath(input.id, 'the id must be one path segment'))
  }
  const allowPersonalData = app.deps.allowPersonalData
  const shown = `${input.kind}/${input.id}`
  const budgetTarget = checkFirebaseTarget('rtdb', `${BUDGET_NODE[input.kind]}/${input.id}`, allowPersonalData)
  const metaTarget = checkFirebaseTarget('rtdb', shown, allowPersonalData)
  const reader = await openReader(app, ctx, { ...input, app: 'campaigns', path: shown })
  const access = await reader.access()
  const budget = checkFirebaseAccess(budgetTarget, access.permissions, reader.workspace)
  const meta = checkFirebaseAccess(metaTarget, access.permissions, reader.workspace)
  const hidden = await hiddenProjects(app, reader, meta.rule)
  if (hidden.has(input.id)) throw new ToolError(messages.firebaseNotFound('rtdb', shown))
  const read = async (checked: CheckedPath) =>
    (
      await reader.send(
        rtdbRequest(app, reader, checked.segments, '', checked.rule.node, checked.segments.join('/')),
        'rtdb',
        checked.segments.join('/')
      )
    ).body
  const [project, stored] = await Promise.all([read(meta), read(budget)])
  if (project === null || typeof project !== 'object') throw new ToolError(messages.firebaseNotFound('rtdb', shown))
  const p = project as Record<string, unknown>
  let list = parseBudgetData(stored)
  if (list.length === 0 && p.list != null) list = parseBudgetData(p.list)
  const currency = typeof p.currency === 'string' ? p.currency : CHF_CURRENCY
  const rates = exchangeRatesOf(p.exchangeRates)
  return finish(
    {
      app: 'campaigns',
      kind: input.kind,
      id: input.id,
      name: p.name ?? null,
      number: p.number ?? null,
      currency,
      total: calculateTotal(list, false, currency, rates),
      totalWithOptions: calculateTotal(list, true, currency, rates),
      allocated: calculateAllocated(list),
      actual: calculateReportsTotal(list, rates),
      storedTotal: p.total ?? null,
      storedAllocated: p.allocated ?? null,
      ...(input.rows === false ? {} : { rows: flattenBudget(list, currency, rates) })
    },
    new Set(),
    0
  )
}
