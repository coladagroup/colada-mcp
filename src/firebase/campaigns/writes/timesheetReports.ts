import type { App } from '../../../app.js'
import { messages, ToolError } from '../../../errors.js'
import type { FirebaseWriteToolContext } from '../../../tools/run.js'
import { isHiddenProject } from '../../policy/rows.js'
import { checkPersonalInput, type PlannedWrite, type WriteTool } from '../../policy/writes.js'
import { assertId, open, partial, type Session, type Target, written } from './common.js'
import { conditionalWrite, NULL_ETAG, type Versioned } from './conditional.js'
import {
  budgetList,
  type CopyPlace,
  checkReportDate,
  copyPlace,
  type Entry,
  hasRow,
  localDate,
  mergeEntry,
  newEntry,
  type ReportFields,
  replaceCopy,
  samePlace,
  withCopy,
  withoutCopy
} from './timesheet.js'

export const ADD_TIMESHEET: WriteTool = 'campaigns_add_timesheet_report'
export const UPDATE_TIMESHEET: WriteTool = 'campaigns_update_timesheet_report'

const PLACE_FIELDS = ['project', 'entity', 'date'] as const

type Booked = { kind: 'project'; record: Record<string, unknown> } | { kind: 'ticket' } | null

async function booked(session: Session, project: string): Promise<Booked> {
  if (project === '') return null
  const stored = (await session.writer.read(`projects/${project}`)).value
  if (stored !== null && typeof stored === 'object') {
    if (isHiddenProject(stored, session.uid, session.role)) {
      throw new ToolError(messages.writeHidden('Project', project))
    }
    return { kind: 'project', record: stored as Record<string, unknown> }
  }
  return (await session.writer.documentExists(`serviceTickets/${project}`)) ? { kind: 'ticket' } : null
}

function checkBooked(found: Booked, project: string, entity: unknown, workspace: string): void {
  if (found === null) throw new ToolError(messages.writeMissingReference('Project', project, workspace))
  if (found.kind === 'ticket' && typeof entity === 'string' && entity !== '') {
    throw new ToolError(messages.writeTicketEntity(project))
  }
}

function legacyOf(found: Booked): unknown {
  return found?.kind === 'project' ? found.record.list : undefined
}

async function readBudget(session: Session, place: CopyPlace, legacy: unknown): Promise<Versioned> {
  const stored = await session.writer.read(`budgets/${place.project}`)
  if (!hasRow(budgetList(stored.value, legacy), place.row)) {
    throw new ToolError(messages.writeMissingReference('Budget row', place.row, session.writer.workspace))
  }
  return stored
}

function budgetWrite(
  session: Session,
  project: string,
  legacy: unknown,
  change: (list: ReturnType<typeof budgetList>) => unknown,
  first?: Versioned
) {
  return conditionalWrite(session.writer, `budgets/${project}`, (current) => change(budgetList(current, legacy)), first)
}

function shown(app: App, entry: Entry): Entry {
  if (app.deps.allowPersonalData) return entry
  const { description: _hidden, ...rest } = entry
  return rest
}

function placeOut(place: CopyPlace | null) {
  return place && { budget: `budgets/${place.project}`, row: place.row, date: place.date }
}

export async function addTimesheetReport(
  app: App,
  ctx: FirebaseWriteToolContext,
  input: Target & ReportFields & { date: string; project: string },
  key: string
) {
  checkPersonalInput(ADD_TIMESHEET, input, app.deps.allowPersonalData)
  assertId(input.project)
  if (input.entity) assertId(input.entity)
  checkReportDate(input.date, localDate(app.deps.now()))
  const planned: PlannedWrite[] = [{ method: 'PUT', path: `timesheet/${key}` }]
  if (input.entity) planned.push({ method: 'PUT', path: `budgets/${input.project}` })
  const session = await open(app, ctx, ADD_TIMESHEET, input, planned)
  const found = await booked(session, input.project)
  checkBooked(found, input.project, input.entity, session.writer.workspace)
  const { realm: _realm, workspace: _workspace, ...fields } = input
  const entry = newEntry(fields, key, session.uid)
  const place = copyPlace(entry, found?.kind === 'project')
  const legacy = legacyOf(found)
  const budget = place && (await readBudget(session, place, legacy))

  const saved = await session.writer.put(`timesheet/${key}`, entry, NULL_ETAG, 0)
  if (!saved.saved) throw new ToolError(messages.writeFailed('PUT', `timesheet/${key}`, 412, 'the key exists already'))
  let retries = 0
  if (place && budget) {
    try {
      retries += (
        await budgetWrite(
          session,
          place.project,
          legacy,
          (list) => withCopy(list, place, entry, session.writer.workspace),
          budget
        )
      ).retries
    } catch (err) {
      partial(
        ctx,
        ADD_TIMESHEET,
        [`budgets/${place.project}`],
        `Entry ${key} is saved, but budgets/${place.project} has no copy. Call ${UPDATE_TIMESHEET} with key ${key} to add it.`,
        err
      )
    }
  }
  return { key, entry: shown(app, entry), copy: placeOut(place), written: written(ctx), retries }
}

export async function updateTimesheetReport(
  app: App,
  ctx: FirebaseWriteToolContext,
  input: Target & ReportFields & { key: string }
) {
  checkPersonalInput(UPDATE_TIMESHEET, input, app.deps.allowPersonalData)
  const { realm: _realm, workspace: _workspace, key, ...fields } = input
  if (Object.values(fields).every((value) => value === undefined)) throw new ToolError(messages.writeNoFields('key'))
  assertId(key)
  if (fields.project !== undefined) assertId(fields.project)
  if (fields.entity) assertId(fields.entity)

  if (fields.date !== undefined) checkReportDate(fields.date, localDate(app.deps.now()))
  const planned: PlannedWrite[] = [{ method: 'PUT', path: `timesheet/${key}` }]
  if (fields.project !== undefined) planned.push({ method: 'PUT', path: `budgets/${fields.project}` })
  const session = await open(app, ctx, UPDATE_TIMESHEET, input, planned)
  const workspace = session.writer.workspace

  const first = await session.writer.read(`timesheet/${key}`)
  const own = (current: unknown): Entry => {
    if (current === null || typeof current !== 'object') {
      throw new ToolError(messages.writeMissingReference('Timesheet entry', key, workspace))
    }
    if ((current as Entry).owner !== session.uid) throw new ToolError(messages.writeForeignEntry(key))
    return current as Entry
  }
  const stored = own(first.value)
  const next = mergeEntry(stored, fields)
  const oldProject = String(stored.project ?? '')
  const oldFound = await booked(session, oldProject)
  const newProject = String(next.project ?? '')
  const newFound = newProject === oldProject ? oldFound : await booked(session, newProject)
  if (newProject !== oldProject || fields.entity) checkBooked(newFound, newProject, next.entity, workspace)
  const from = copyPlace(stored, oldFound?.kind === 'project')
  const to = copyPlace(next, newFound?.kind === 'project')
  const newLegacy = legacyOf(newFound)
  const oldLegacy = legacyOf(oldFound)
  const toBudget = to && (await readBudget(session, to, newLegacy))

  const result = await conditionalWrite(
    session.writer,
    `timesheet/${key}`,
    (current) => {
      const fresh = own(current)
      if (PLACE_FIELDS.some((field) => fresh[field] !== stored[field]))
        throw new ToolError(messages.writeEntryMoved(key))
      return mergeEntry(fresh, fields)
    },
    first
  )
  const entry = result.value as Entry
  let retries = result.retries
  const mode = from === null && to === null ? 'none' : samePlace(from, to) ? 'in-place' : 'move'
  const copy = { mode, from: placeOut(from), to: placeOut(to) }
  const finish = () => ({ key, entry: shown(app, entry), copy, written: written(ctx), retries })
  const toPlace = to === null ? null : { ...to, date: String(entry.date) }

  if (mode === 'in-place' && toPlace) {
    try {
      retries += (
        await budgetWrite(
          session,
          toPlace.project,
          newLegacy,
          (list) => replaceCopy(list, toPlace, entry, workspace),
          toBudget ?? undefined
        )
      ).retries
    } catch (err) {
      partial(
        ctx,
        UPDATE_TIMESHEET,
        [`budgets/${toPlace.project}`],
        `The copy in budgets/${toPlace.project} still has the old values.`,
        err
      )
    }
    return finish()
  }
  if (toPlace) {
    const notSaved = [
      `budgets/${toPlace.project}`,
      ...(from && from.project !== toPlace.project ? [`budgets/${from.project}`] : [])
    ]
    try {
      retries += (
        await budgetWrite(
          session,
          toPlace.project,
          newLegacy,
          (list) => withCopy(list, toPlace, entry, workspace),
          toBudget ?? undefined
        )
      ).retries
    } catch (err) {
      const state = from
        ? `The copy is still only in budgets/${from.project}.`
        : `budgets/${toPlace.project} has no copy.`
      partial(ctx, UPDATE_TIMESHEET, notSaved, state, err)
    }
  }
  if (from && from.project !== toPlace?.project) {
    try {
      retries += (await budgetWrite(session, from.project, oldLegacy, (list) => withoutCopy(list, key))).retries
    } catch (err) {
      const state = toPlace
        ? `The copy is in both budgets/${toPlace.project} and budgets/${from.project}.`
        : `The old copy is still in budgets/${from.project}.`
      partial(ctx, UPDATE_TIMESHEET, [`budgets/${from.project}`], state, err)
    }
  }
  return finish()
}
