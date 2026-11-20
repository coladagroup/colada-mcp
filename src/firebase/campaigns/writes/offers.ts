import { randomUUID } from 'node:crypto'
import type { App } from '../../../app.js'
import { fail } from '../../../errors.js'
import type { FirebaseWriteToolContext } from '../../../tools/run.js'
import { isHiddenProject } from '../../policy/rows.js'
import { checkPersonalInput, PERSONAL_INPUT_FIELDS, type PlannedWrite, type WriteTool } from '../../policy/writes.js'
import { assertId, defined, nowJson, open, partial, type Session, type Target, written } from './common.js'
import { conditionalWrite } from './conditional.js'
import {
  checkEventFormats,
  checkEventPairs,
  defaultBudget,
  type Fields,
  findTreeNode,
  fromLead,
  generatePrefix,
  newLead,
  newOffer,
  nextCounter,
  offerChanges,
  offerNumber,
  REQUIRED_OFFER_FIELDS,
  requireFields,
  taskBoardScaffold,
  treeNodes
} from './offer.js'

export const CREATE_OFFER: WriteTool = 'campaigns_create_offer'
export const UPDATE_OFFER: WriteTool = 'campaigns_update_offer'
export const CREATE_LEAD: WriteTool = 'campaigns_create_lead'
export const UPDATE_LEAD: WriteTool = 'campaigns_update_lead'

export interface FreshIds {
  id: string
  externalId: string
}

const DEAL_SYNCED = ['name', 'status'] as const

function isRecord(value: unknown): value is Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function shown(app: App, tool: WriteTool, record: Fields): Fields {
  if (app.deps.allowPersonalData) return record
  return Object.fromEntries(Object.entries(record).filter(([key]) => !PERSONAL_INPUT_FIELDS[tool].includes(key)))
}

const SHOWN_COST_CENTERS = 20

async function checkCostCenter(session: Session, costCenter: unknown): Promise<void> {
  if (typeof costCenter !== 'string' || costCenter === '') return
  const stored = (await session.writer.read('costCenters')).value
  const tree = isRecord(stored) && 'list' in stored ? stored.list : stored
  if (findTreeNode(tree, costCenter) !== null) return
  const known = treeNodes(tree).map((node) => `${String(node.uid)}: ${String(node.name ?? '')}`)
  throw fail.writeUnknownCostCenter(
    costCenter,
    session.writer.workspace,
    known.slice(0, SHOWN_COST_CENTERS),
    Math.max(0, known.length - SHOWN_COST_CENTERS)
  )
}

async function checkedUser(
  app: App,
  ctx: FirebaseWriteToolContext,
  session: Session,
  field: string,
  value: string
): Promise<string> {
  const { users } = await app.realm(ctx.realm ?? undefined)
  const uid = await users.resolve(session.writer.workspace, field, value, session.uid)
  ctx.checkedUsers.add(uid)
  return uid
}

async function resolveProjectManager(app: App, ctx: FirebaseWriteToolContext, session: Session, fields: Fields) {
  const value = fields.projectManager
  if (typeof value === 'string' && value !== '') {
    fields.projectManager = await checkedUser(app, ctx, session, 'projectManager', value)
  }
}

export async function createOffer(
  app: App,
  ctx: FirebaseWriteToolContext,
  input: Target & Fields & { lead?: string },
  fresh: FreshIds
) {
  checkPersonalInput(CREATE_OFFER, input, app.deps.allowPersonalData)
  const { realm: _realm, workspace: _workspace, lead, ...given } = input
  const fields = defined(given)
  if (lead !== undefined) assertId(lead)
  if (typeof fields.costCenter === 'string' && fields.costCenter !== '') assertId(fields.costCenter)
  checkEventFormats(fields)
  checkEventPairs(fields, {})
  if (lead === undefined) requireFields(fields, REQUIRED_OFFER_FIELDS)
  const id = lead ?? fresh.id
  const planned: PlannedWrite[] = [
    { method: 'PUT', path: 'projectCounter' },
    { method: 'PATCH', path: `planner/${id}` },
    { method: 'PATCH', path: `plannerBudgets/${id}` },
    lead === undefined
      ? { method: 'PATCH', path: `taskBoards/${id}` }
      : { method: 'PATCH', path: `taskBoards/${id}/prefix` }
  ]
  if (lead === undefined) planned.push({ method: 'PATCH', path: `/externalIds/${fresh.externalId}` })
  const session = await open(app, ctx, CREATE_OFFER, input, planned)
  const workspace = session.writer.workspace
  await resolveProjectManager(app, ctx, session, fields)

  let settings = fields
  let externalId: unknown = fresh.externalId
  let prefix = fields.prefix
  if (lead !== undefined) {
    const deal = (await session.writer.read(`deals/${lead}`)).value
    if (!isRecord(deal)) throw fail.writeMissingReference('Lead', lead, workspace)
    if ((await session.writer.read(`planner/${lead}`)).value !== null) {
      throw fail.writeLeadHasOffer(lead)
    }
    settings = { ...fromLead(deal), ...fields }
    requireFields(settings, REQUIRED_OFFER_FIELDS)
    externalId = deal.externalId
    prefix ??= (await session.writer.read(`taskBoards/${lead}/prefix`)).value || undefined
  }
  await checkCostCenter(session, settings.costCenter)
  const boardPrefix = typeof prefix === 'string' ? prefix : generatePrefix(settings.name)

  const counter = await conditionalWrite(session.writer, 'projectCounter', nextCounter)
  const number = offerNumber(counter.value as number, new Date(app.deps.now() * 1000).getFullYear())
  const offer = newOffer(settings, { uid: id, externalId, number }, session.uid, nowJson(app))
  const body: Fields = {
    [`planner/${id}`]: offer,
    [`plannerBudgets/${id}`]: defaultBudget(randomUUID())
  }
  if (lead === undefined) {
    body[`taskBoards/${id}`] = taskBoardScaffold(id, boardPrefix)
    body[`/externalIds/${fresh.externalId}`] = { source: id, workspace }
  } else {
    body[`taskBoards/${id}/prefix`] = boardPrefix
  }
  try {
    await session.writer.patch('', body)
  } catch (err) {
    partial(
      ctx,
      CREATE_OFFER,
      Object.keys(body),
      `Offer number ${number} is skipped. Nothing of the offer was written.`,
      err
    )
  }
  return {
    id,
    number,
    externalId: externalId ?? null,
    offer: shown(app, CREATE_OFFER, offer),
    budgetRows: 1,
    taskBoards: lead === undefined ? 'scaffold' : 'prefix',
    written: written(ctx),
    retries: counter.retries
  }
}

export async function updateOffer(app: App, ctx: FirebaseWriteToolContext, input: Target & Fields & { offer: string }) {
  checkPersonalInput(UPDATE_OFFER, input, app.deps.allowPersonalData)
  const { realm: _realm, workspace: _workspace, offer, ...given } = input
  const fields = defined(given)
  if (Object.keys(fields).length === 0) throw fail.writeNoFields('offer')
  assertId(offer)
  if (typeof fields.costCenter === 'string' && fields.costCenter !== '') assertId(fields.costCenter)
  checkEventFormats(fields)
  const sideFields = [
    ...(fields.client !== undefined ? ['person'] : []),
    ...(fields.location !== undefined ? ['rooms'] : [])
  ]
  const synced = DEAL_SYNCED.filter((field) => fields[field] !== undefined)
  const dealFields = synced.length > 0 ? [...synced, 'updatedAt', 'updatedBy'] : []
  const planned: PlannedWrite[] = [
    ...[...Object.keys(fields), ...sideFields, 'updatedAt', 'updatedBy'].map((field) => ({
      method: 'PATCH',
      path: `planner/${offer}/${field}`
    })),
    ...dealFields.map((field) => ({ method: 'PATCH', path: `deals/${offer}/${field}` }))
  ]
  const session = await open(app, ctx, UPDATE_OFFER, input, planned)
  const workspace = session.writer.workspace
  await resolveProjectManager(app, ctx, session, fields)

  const stored = (await session.writer.read(`planner/${offer}`)).value
  if (!isRecord(stored)) throw fail.writeMissingReference('Offer', offer, workspace)
  if (isHiddenProject(stored, session.uid, session.role)) throw fail.writeHidden('Offer', offer)
  if (stored.archived) throw fail.writeArchived(offer)
  checkEventPairs(fields, stored)
  await checkCostCenter(session, fields.costCenter)
  const dealExists = isRecord((await session.writer.read(`deals/${offer}`)).value)
  const dealSynced = dealExists ? synced : []

  const changes = offerChanges(fields, stored)
  const now = nowJson(app)
  const body: Fields = {}
  for (const [field, value] of Object.entries({ ...changes, updatedAt: now, updatedBy: session.uid })) {
    body[`planner/${offer}/${field}`] = value
  }
  if (dealSynced.length > 0) {
    for (const field of dealSynced) body[`deals/${offer}/${field}`] = fields[field]
    body[`deals/${offer}/updatedAt`] = now
    body[`deals/${offer}/updatedBy`] = session.uid
  }
  await session.writer.patch('', body)
  return {
    offer,
    changed: Object.keys(changes),
    deal: { exists: dealExists, synced: dealSynced },
    written: written(ctx)
  }
}

export async function createLead(
  app: App,
  ctx: FirebaseWriteToolContext,
  input: Target & Fields & { name: string },
  fresh: FreshIds
) {
  checkPersonalInput(CREATE_LEAD, input, app.deps.allowPersonalData)
  const { realm: _realm, workspace: _workspace, ...given } = input
  const fields = defined(given)
  const { id, externalId } = fresh
  const planned: PlannedWrite[] = [
    { method: 'PATCH', path: `deals/${id}` },
    { method: 'PATCH', path: `taskBoards/${id}` },
    { method: 'PATCH', path: `/externalIds/${externalId}` }
  ]
  const session = await open(app, ctx, CREATE_LEAD, input, planned)
  fields.accountManager =
    typeof fields.accountManager === 'string' && fields.accountManager !== ''
      ? await checkedUser(app, ctx, session, 'accountManager', fields.accountManager)
      : session.uid
  const lead = newLead(fields, { uid: id, externalId }, session.uid, nowJson(app))
  const prefix = typeof fields.prefix === 'string' ? fields.prefix : generatePrefix(fields.name)
  await session.writer.patch('', {
    [`deals/${id}`]: lead,
    [`taskBoards/${id}`]: taskBoardScaffold(id, prefix),
    [`/externalIds/${externalId}`]: { source: id, workspace: session.writer.workspace }
  })
  return { id, externalId, lead, written: written(ctx) }
}

export async function updateLead(app: App, ctx: FirebaseWriteToolContext, input: Target & Fields & { lead: string }) {
  checkPersonalInput(UPDATE_LEAD, input, app.deps.allowPersonalData)
  const { realm: _realm, workspace: _workspace, lead, ...given } = input
  assertId(lead)
  const fields = defined(given)
  if (Object.keys(fields).length === 0) throw fail.writeNoFields('lead')
  const planned: PlannedWrite[] = [
    { method: 'PATCH', path: `deals/${lead}/updatedAt` },
    ...DEAL_SYNCED.filter((field) => field in fields).map((field) => ({
      method: 'PATCH',
      path: `planner/${lead}/${field}`
    }))
  ]
  const session = await open(app, ctx, UPDATE_LEAD, input, planned)
  if (typeof fields.accountManager === 'string') {
    fields.accountManager = await checkedUser(app, ctx, session, 'accountManager', fields.accountManager)
  }
  const stored = (await session.writer.read(`deals/${lead}`)).value
  if (!isRecord(stored)) throw fail.writeMissingReference('Lead', lead, session.writer.workspace)
  if (stored.archived) throw fail.writeLeadArchived(lead)
  const synced = DEAL_SYNCED.filter((field) => field in fields)
  const offerExists = isRecord((await session.writer.read(`planner/${lead}`)).value)
  const audit = { updatedAt: nowJson(app), updatedBy: session.uid }
  const body: Fields = Object.fromEntries(
    Object.entries({ ...fields, ...audit }).map(([field, value]) => [`deals/${lead}/${field}`, value])
  )
  if (offerExists) {
    for (const field of synced) body[`planner/${lead}/${field}`] = fields[field]
  }
  await session.writer.patch('', body)
  return {
    lead,
    changed: Object.keys(fields),
    offer: { exists: offerExists, synced: offerExists ? synced : [] },
    written: written(ctx)
  }
}
