import type { App } from '../../../app.js'
import { fail } from '../../../errors.js'
import type { FirebaseWriteToolContext } from '../../../tools/run.js'
import { isHiddenProject } from '../../policy/rows.js'
import { checkPersonalInput, PERSONAL_INPUT_FIELDS, type PlannedWrite, type WriteTool } from '../../policy/writes.js'
import { assertId, defined, nowJson, open, partial, type Session, type Target, written } from './common.js'
import { conditionalWrite } from './conditional.js'
import { rankAtEnd } from './taskRanks.js'

export const CREATE_TASK: WriteTool = 'campaigns_create_task'
export const UPDATE_TASK: WriteTool = 'campaigns_update_task'

export const TASK_PRIORITIES = ['low', 'medium', 'high'] as const
const BACKLOG = 'backlog'
const ARCHIVED = 'archived'
const MENTION = /data-mention-id="([^"]*)"/g

type Fields = Record<string, unknown>

interface Board {
  key: string
  id: string
  final: boolean
  tasks: unknown
}

export interface FreshTaskIds {
  uid: string
  externalId: string
}

interface TaskFields {
  name?: string
  summary?: string
  dueDate?: string
  priority?: string
  assignees?: string[]
}

export interface CreateTaskInput extends Target, TaskFields {
  source: string
  name: string
  board?: string
  invoice?: string
}

export interface UpdateTaskInput extends Target, TaskFields {
  source: string
  task: string
  board?: string
}

function isRecord(value: unknown): value is Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function boardsOf(value: unknown): Board[] {
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value)
    .filter((entry): entry is [string, Fields] => isRecord(entry[1]))
    .map(([key, board]) => ({ key, id: String(board.id ?? ''), final: board.final === true, tasks: board.tasks }))
}

function boardById(boards: Board[], id: string, source: string): Board {
  const board = boards.find((candidate) => candidate.id === id)
  if (board) return board
  const known = boards.map((candidate) => candidate.id).filter((candidate) => candidate !== ARCHIVED)
  throw fail.writeUnknownBoard(id, source, known)
}

function findTask(boards: Board[], uid: string): { board: Board; key: string; task: Fields } | null {
  for (const board of boards) {
    if (board.tasks === null || typeof board.tasks !== 'object') continue
    for (const [key, task] of Object.entries(board.tasks)) {
      if (isRecord(task) && task.uid === uid) return { board, key, task }
    }
  }
  return null
}

function mentionsOf(text: unknown): string[] {
  if (typeof text !== 'string') return []
  return [...new Set(Array.from(text.matchAll(MENTION), (match) => match[1] ?? ''))]
}

function commentMentions(comments: unknown): string[] {
  if (!Array.isArray(comments)) return []
  return [...new Set(comments.flatMap((comment) => mentionsOf(isRecord(comment) ? comment.text : undefined)))]
}

function assignedAt(assignees: unknown, previous: unknown, now: string): Fields | '' {
  if (!Array.isArray(assignees) || assignees.length === 0) return ''
  const before = isRecord(previous) ? previous : {}
  const result: Fields = {}
  for (const assignee of assignees) {
    if (typeof assignee === 'string' && !assignee.includes('@')) result[assignee] = before[assignee] || now
  }
  return result
}

function shown(app: App, tool: WriteTool, task: Fields): Fields {
  if (app.deps.allowPersonalData) return task
  const personal: readonly string[] = [...PERSONAL_INPUT_FIELDS[tool], 'mentions', 'mentionsComment', 'comments']
  return Object.fromEntries(Object.entries(task).filter(([key]) => !personal.includes(key)))
}

async function checkSource(session: Session, source: string) {
  for (const node of ['projects', 'planner']) {
    const record = (await session.writer.read(`${node}/${source}`)).value
    if (isHiddenProject(record, session.uid, session.role)) throw fail.writeHidden('Task board source', source)
  }
}

async function resolveAssignees(
  app: App,
  ctx: FirebaseWriteToolContext,
  session: Session,
  values: string[] | undefined
): Promise<string[] | undefined> {
  if (values === undefined) return undefined
  const { users } = await app.realm(ctx.realm ?? undefined)
  const uids: string[] = []
  for (const value of values) {
    const uid = await users.resolve(session.writer.workspace, 'assignees', value, session.uid)
    ctx.checkedUsers.add(uid)
    if (!uids.includes(uid)) uids.push(uid)
  }
  return uids
}

function checkTargetBoard(board: string | undefined) {
  if (board === ARCHIVED) throw fail.writeArchiveBoard()
}

export async function createTask(app: App, ctx: FirebaseWriteToolContext, input: CreateTaskInput, fresh: FreshTaskIds) {
  checkPersonalInput(CREATE_TASK, input, app.deps.allowPersonalData)
  const { source, invoice } = input
  assertId(source)
  if (invoice !== undefined) assertId(invoice)
  const boardId = input.board ?? BACKLOG
  checkTargetBoard(boardId)
  const counterPath = `taskBoards/${source}/taskCounter`
  const planned: PlannedWrite[] = [
    { method: 'PUT', path: counterPath },
    { method: 'PATCH', path: `taskBoards/${source}/boards/${boardId}/tasks/${fresh.uid}` },
    { method: 'PATCH', path: `/externalIds/${fresh.externalId}` }
  ]
  if (invoice !== undefined) planned.push({ method: 'PUT', path: `invoices/${source}/${invoice}/tasks` })
  const session = await open(app, ctx, CREATE_TASK, input, planned)
  const workspace = session.writer.workspace

  const taskBoards = (await session.writer.read(`taskBoards/${source}`)).value
  if (!isRecord(taskBoards) || (!isRecord(taskBoards.boards) && !Array.isArray(taskBoards.boards))) {
    throw fail.writeNoTaskBoards(source, workspace)
  }
  await checkSource(session, source)
  const board = boardById(boardsOf(taskBoards.boards), boardId, source)
  if (invoice !== undefined && !isRecord((await session.writer.read(`invoices/${source}/${invoice}`)).value)) {
    throw fail.writeMissingReference('Invoice', invoice, workspace)
  }
  const assignees = await resolveAssignees(app, ctx, session, input.assignees)

  const counter = await conditionalWrite(session.writer, counterPath, (current) =>
    typeof current === 'number' ? current + 1 : 1
  )
  const prefix = typeof taskBoards.prefix === 'string' ? taskBoards.prefix : ''
  const number = prefix ? `${prefix}-${counter.value}` : String(counter.value)
  const now = nowJson(app)
  const task: Fields = {
    uid: fresh.uid,
    board: boardId,
    source,
    name: input.name,
    ...defined({ summary: input.summary, dueDate: input.dueDate }),
    assignees: assignees && assignees.length > 0 ? assignees : '',
    ...(invoice !== undefined ? { node: { uid: invoice, path: `invoices/${source}` } } : {}),
    priority: input.priority ?? 'low',
    owner: session.uid,
    watchers: [session.uid],
    mentions: mentionsOf(input.summary),
    mentionsComment: [],
    updatedAt: now,
    createdAt: now,
    assignedAt: assignedAt(assignees, undefined, now),
    externalId: fresh.externalId,
    number,
    rank: rankAtEnd(board.tasks)
  }
  const taskPath = `taskBoards/${source}/boards/${board.key}/tasks/${fresh.uid}`
  const body = { [taskPath]: task, [`/externalIds/${fresh.externalId}`]: { source: fresh.uid, workspace } }
  try {
    await session.writer.patch('', body)
  } catch (err) {
    partial(ctx, CREATE_TASK, Object.keys(body), `Task number ${number} is skipped. The task was not written.`, err)
  }
  let invoiceTasks: unknown = null
  if (invoice !== undefined) {
    const path = `invoices/${source}/${invoice}/tasks`
    try {
      invoiceTasks = (
        await conditionalWrite(session.writer, path, (current) => (typeof current === 'number' ? current + 1 : 1))
      ).value
    } catch (err) {
      partial(ctx, CREATE_TASK, [path], 'The task is saved, but the task count of the invoice is not raised.', err)
    }
  }
  return {
    task: shown(app, CREATE_TASK, task),
    number,
    board: boardId,
    ...(invoice !== undefined ? { invoiceTasks } : {}),
    written: written(ctx),
    retries: counter.retries
  }
}

export async function updateTask(app: App, ctx: FirebaseWriteToolContext, input: UpdateTaskInput) {
  checkPersonalInput(UPDATE_TASK, input, app.deps.allowPersonalData)
  const { source, task: uid } = input
  assertId(source)
  assertId(uid)
  const fields = defined({
    name: input.name,
    summary: input.summary,
    dueDate: input.dueDate,
    priority: input.priority,
    assignees: input.assignees
  })
  if (Object.keys(fields).length === 0 && input.board === undefined) throw fail.writeNoFields('task')
  checkTargetBoard(input.board)
  const taskPath = `taskBoards/${source}/boards/board/tasks/${uid}`
  const planned: PlannedWrite[] = [
    ...[...Object.keys(fields), 'mentions', 'assignedAt', 'updatedAt', 'updatedBy'].map((field) => ({
      method: 'PATCH',
      path: `${taskPath}/${field}`
    })),
    ...(input.board !== undefined ? [{ method: 'PATCH', path: taskPath }] : [])
  ]
  const session = await open(app, ctx, UPDATE_TASK, input, planned)
  const workspace = session.writer.workspace

  const stored = (await session.writer.read(`taskBoards/${source}/boards`)).value
  if (stored === null || typeof stored !== 'object') throw fail.writeNoTaskBoards(source, workspace)
  await checkSource(session, source)
  const boards = boardsOf(stored)
  const location = findTask(boards, uid)
  if (location === null) throw fail.writeUnknownTask(uid, source)
  if (location.task.archived || location.board.id === ARCHIVED) throw fail.writeTaskArchived(uid)
  const toBoard =
    input.board !== undefined && input.board !== location.board.id ? boardById(boards, input.board, source) : null
  const assignees = await resolveAssignees(app, ctx, session, fields.assignees)

  const now = nowJson(app)
  const changes: Fields = { ...fields }
  if (assignees !== undefined) changes.assignees = assignees.length > 0 ? assignees : ''
  const merged = { ...location.task, ...changes }
  const audit = {
    mentions: mentionsOf(merged.summary),
    assignedAt: assignedAt(merged.assignees, location.task.assignedAt, now),
    updatedBy: session.uid,
    updatedAt: now
  }
  const fromPath = `taskBoards/${source}/boards/${location.board.key}/tasks/${location.key}`
  let body: Fields
  if (toBoard === null) {
    body = Object.fromEntries(
      Object.entries({ ...changes, ...audit }).map(([field, value]) => [`${fromPath}/${field}`, value])
    )
  } else {
    const { sourceName: _s, sourcePath: _p, boardName: _b, hadRank: _h, ...task } = merged
    const moved: Fields = {
      ...task,
      ...audit,
      mentionsComment: commentMentions(task.comments),
      board: toBoard.id,
      rank: rankAtEnd(toBoard.tasks),
      ...(toBoard.final ? { finishedAt: now, finishedBy: session.uid } : {})
    }
    if (typeof task.owner === 'string') ctx.checkedUsers.add(task.owner)
    body = { [fromPath]: null, [`taskBoards/${source}/boards/${toBoard.key}/tasks/${uid}`]: moved }
  }
  await session.writer.patch('', body)
  return {
    task: uid,
    number: location.task.number ?? null,
    changed: Object.keys(changes),
    board: { from: location.board.id, to: toBoard?.id ?? location.board.id },
    written: written(ctx)
  }
}
