import { randomUUID } from 'node:crypto'
import type { App } from '../../../app.js'
import { messages, ToolError } from '../../../errors.js'
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
  fromLead,
  generatePrefix,
  hasTreeNode,
  newLead,
  newOffer,
  nextCounter,
  offerChanges,
  offerNumber,
  REQUIRED_OFFER_FIELDS,
  requireFields,
  taskBoardScaffold
} from './offer.js'

export const CREATE_OFFER: WriteTool = 'campaigns_create_offer'
export const UPDATE_OFFER: WriteTool = 'campaigns_update_offer'
export const CREATE_LEAD: WriteTool = 'campaigns_create_lead'

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

async function checkCostCenter(session: Session, costCenter: unknown): Promise<void> {
  if (typeof costCenter !== 'string' || costCenter === '') return
  const tree = (await session.writer.read('costCenters')).value
  if (!hasTreeNode(tree, costCenter)) {
    throw new ToolError(messages.writeMissingReference('Cost center', costCenter, session.writer.workspace))
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

  let settings = fields
  let externalId: unknown = fresh.externalId
  let prefix = fields.prefix
  if (lead !== undefined) {
    const deal = (await session.writer.read(`deals/${lead}`)).value
    if (!isRecord(deal)) throw new ToolError(messages.writeMissingReference('Lead', lead, workspace))
    if ((await session.writer.read(`planner/${lead}`)).value !== null) {
      throw new ToolError(messages.writeLeadHasOffer(lead))
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
  if (Object.keys(fields).length === 0) throw new ToolError(messages.writeNoFields('offer'))
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

  const stored = (await session.writer.read(`planner/${offer}`)).value
  if (!isRecord(stored)) throw new ToolError(messages.writeMissingReference('Offer', offer, workspace))
  if (isHiddenProject(stored, session.uid, session.role)) throw new ToolError(messages.writeHidden('Offer', offer))
  if (stored.archived) throw new ToolError(messages.writeArchived(offer))
  checkEventPairs(fields, stored)
  await checkCostCenter(session, fields.costCenter)
  const dealExists = synced.length > 0 && isRecord((await session.writer.read(`deals/${offer}`)).value)

  const changes = offerChanges(fields, stored)
  const now = nowJson(app)
  const body: Fields = {}
  for (const [field, value] of Object.entries({ ...changes, updatedAt: now, updatedBy: session.uid })) {
    body[`planner/${offer}/${field}`] = value
  }
  if (dealExists) {
    for (const field of synced) body[`deals/${offer}/${field}`] = fields[field]
    body[`deals/${offer}/updatedAt`] = now
    body[`deals/${offer}/updatedBy`] = session.uid
  }
  await session.writer.patch('', body)
  return {
    offer,
    changed: Object.keys(changes),
    deal: dealExists ? { synced } : null,
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
  const lead = newLead(fields, { uid: id, externalId }, session.uid, nowJson(app))
  const prefix = typeof fields.prefix === 'string' ? fields.prefix : generatePrefix(fields.name)
  await session.writer.patch('', {
    [`deals/${id}`]: lead,
    [`taskBoards/${id}`]: taskBoardScaffold(id, prefix),
    [`/externalIds/${externalId}`]: { source: id, workspace: session.writer.workspace }
  })
  return { id, externalId, lead, written: written(ctx) }
}
