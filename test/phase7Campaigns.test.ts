import { afterEach, describe, expect, it } from 'vitest'
import { type WriteOp, writeRefusal } from '../src/firebase/policy/writes.js'
import { firebaseSetup, ME, rtdbRequests } from './firebaseFake.js'
import { fakeUser, type Harness, WS_A } from './harness.js'

const WS = WS_A
const NOW = '2027-01-15T08:00:00.000Z'
const PROD_HOST = 'admin.colada365.com'
const UPDATE_PROJECT = 'campaigns_update_project'
const CREATE_TASK = 'campaigns_create_task'
const UPDATE_TASK = 'campaigns_update_task'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

function boards() {
  return [
    {
      id: 'backlog',
      tasks: {
        t1: {
          uid: 't1',
          name: 'Book venue',
          number: 'GA-3',
          rank: 'a0',
          owner: 'boss',
          board: 'backlog',
          source: 'o1',
          priority: 'low',
          assignees: ['u-am'],
          assignedAt: { 'u-am': '2027-01-01T00:00:00.000Z' },
          comments: [{ text: '<span data-mention-id="u-am">x</span>' }],
          subtasks: [{ uid: 's1', name: 'Call', owner: 'boss' }]
        }
      }
    },
    { id: 'progress', tasks: { t9: { uid: 't9', rank: 'a5' } } },
    { id: 'finished', final: true },
    { id: 'archived', tasks: { t2: { uid: 't2', name: 'Old' } } }
  ]
}

async function setup(options: { allowPersonalData?: boolean; permissions?: string[]; host?: string } = {}) {
  const result = await firebaseSetup({ allowPersonalData: options.allowPersonalData ?? true, host: options.host })
  harnesses.push(result.h)
  result.fw.permissions = options.permissions ?? [
    'campaigns_app:view',
    'campaigns_app/projects/settings:manage',
    'campaigns_app/offers/tasks:manage',
    'campaigns_app/projects/tasks:manage'
  ]
  result.fw.world.users.set(WS, [fakeUser(ME, 'frank@colada.test'), fakeUser('u-am', 'am@b.ch')])
  result.fw.rtdb[WS] = {
    projects: {
      p1: { uid: 'p1', name: 'Fair', status: 'inProgress', type: 'event', owner: 'boss', total: 10 },
      p2: { uid: 'p2', name: 'Done', archived: true },
      p3: { uid: 'p3', name: 'Secret', isPrivate: true, owner: 'boss' }
    },
    planner: { o1: { uid: 'o1', name: 'Gala', owner: 'boss' } },
    taskBoards: {
      o1: { uid: 'o1', prefix: 'GA', taskCounter: 4, boards: boards() },
      p1: { uid: 'p1', prefix: '', taskCounter: 0, boards: boards() }
    },
    invoices: { p1: { inv1: { uid: 'inv1', tasks: 2 } } }
  }
  return result
}

type Fw = Awaited<ReturnType<typeof setup>>['fw']
type World = Awaited<ReturnType<typeof setup>>['world']

const writes = (world: World) => rtdbRequests(world).filter((request) => request.method !== 'GET')
const call = (h: Harness, tool: string, args: Record<string, unknown>) => h.call(tool, { workspace: WS, ...args })
const strip = (path: string) => path.replace(/^\//, '').replace(new RegExp(`^workspaces/${WS}/?`), '')
const sentBodies = (world: World) =>
  writes(world).map((request) => ({
    method: request.method,
    path: strip(request.url.pathname.replace(/\.json$/, '')),
    body: Object.fromEntries(
      Object.entries(JSON.parse(String(request.body)) as Record<string, unknown>).map(([key, value]) => [
        strip(key),
        value
      ])
    )
  }))
const taskBoard = (fw: Fw, source: string) =>
  (fw.rtdb[WS]?.taskBoards as Record<string, { taskCounter: number; boards: Array<{ tasks?: object }> }> | undefined)?.[
    source
  ]
const tasksOn = (fw: Fw, source: string, key: number) =>
  (taskBoard(fw, source)?.boards[key]?.tasks ?? {}) as Record<string, Record<string, unknown> | null>
const project = (fw: Fw, id: string) =>
  (fw.rtdb[WS]?.projects as Record<string, Record<string, unknown>> | undefined)?.[id]

async function refusedWithoutWrites(
  h: Harness,
  world: World,
  tool: string,
  args: Record<string, unknown>,
  text: string
) {
  const result = await call(h, tool, args)
  expect(result.isError).toBe(true)
  expect(result.body.error).toContain(text)
  expect(writes(world)).toEqual([])
}

describe('campaigns_update_project (S6, AC-7.5, AC-7.7)', () => {
  it('writes only status and updatedAt, like useProjectSettings.update', async () => {
    const { h, fw, world } = await setup()
    const result = await call(h, UPDATE_PROJECT, { project: 'p1', status: 'toBeInvoiced' })
    expect(result.isError).toBe(false)
    expect(sentBodies(world)).toEqual([
      { method: 'PATCH', path: '', body: { 'projects/p1/status': 'toBeInvoiced', 'projects/p1/updatedAt': NOW } }
    ])
    expect(project(fw, 'p1')).toMatchObject({ status: 'toBeInvoiced', type: 'event', total: 10, owner: 'boss' })
    expect(result.body).toMatchObject({ changed: ['status'], before: { status: 'inProgress' } })
  })

  it('sets type and status together, and "" clears', async () => {
    const { h, fw } = await setup()
    await call(h, UPDATE_PROJECT, { project: 'p1', status: '', type: 'service' })
    expect(project(fw, 'p1')).toMatchObject({ status: '', type: 'service', updatedAt: NOW })
  })

  it.each([
    [{ project: 'p1', status: 'open' }],
    [{ project: 'p1', type: 'serviceTicket' }],
    [{ project: 'p1', name: 'Renamed' }],
    [{ project: 'p1', status: 'paid', total: 0 }]
  ])('refuses a value outside the app options or another field before any write: %o', async (args) => {
    const { h, world } = await setup()
    await expect(call(h, UPDATE_PROJECT, args)).rejects.toThrow('MCP error')
    expect(writes(world)).toEqual([])
  })

  it.each([
    [{ project: 'p1' }, 'Pass at least one field'],
    [{ project: 'nope', status: 'paid' }, 'does not exist'],
    [{ project: 'p2', status: 'paid' }, 'is archived'],
    [{ project: 'p3', status: 'paid' }, 'hidden from you']
  ])('refuses %o without writing', async (args, text) => {
    const { h, world } = await setup()
    await refusedWithoutWrites(h, world, UPDATE_PROJECT, args, text)
  })

  it('needs campaigns_app/projects/settings:manage', async () => {
    const { h, world } = await setup({ permissions: ['campaigns_app:view'] })
    await refusedWithoutWrites(h, world, UPDATE_PROJECT, { project: 'p1', status: 'paid' }, 'projects/settings:manage')
  })

  const ws = `workspaces/${WS}`
  it.each<[string, string, WriteOp]>([
    ['another field', UPDATE_PROJECT, { method: 'PATCH', path: '', body: { [`${ws}/projects/p1/name`]: 'x' } }],
    ['the whole node', UPDATE_PROJECT, { method: 'PATCH', path: '', body: { [`${ws}/projects/p1`]: { status: 'x' } } }],
    ['a PUT of status', UPDATE_PROJECT, { method: 'PUT', path: `${ws}/projects/p1/status`, body: 'paid' }],
    ['a deeper path', UPDATE_PROJECT, { method: 'PATCH', path: '', body: { [`${ws}/projects/p1/status/x`]: 'y' } }],
    [
      'status from another tool',
      'campaigns_update_offer',
      {
        method: 'PATCH',
        path: '',
        body: { [`${ws}/projects/p1/status`]: 'paid' }
      }
    ]
  ])('any other projects/ write is still X1: %s', (_name, tool, op) => {
    expect(writeRefusal(tool as never, op, { workspace: WS, uid: ME })).toBe('X1')
  })
})

describe('campaigns_create_task (S7, AC-7.5)', () => {
  it('writes the task like createTask: next number with prefix, end of the board, owner you, priority low', async () => {
    const { h, fw, world } = await setup()
    const result = await call(h, CREATE_TASK, { source: 'o1', name: 'Bitte anbieten' })
    expect(result.isError).toBe(false)
    const [counter, patch] = sentBodies(world)
    expect(counter).toEqual({ method: 'PUT', path: 'taskBoards/o1/taskCounter', body: expect.anything() })
    expect(taskBoard(fw, 'o1')?.taskCounter).toBe(5)
    const uid = Object.keys(tasksOn(fw, 'o1', 0)).find((key) => key !== 't1') as string
    expect(uid).toMatch(UUID)
    expect(tasksOn(fw, 'o1', 0)[uid]).toMatchObject({ uid, number: 'GA-5' })
    const task = patch?.body[`taskBoards/o1/boards/0/tasks/${uid}`] as Record<string, unknown> | undefined
    expect(task).toEqual({
      uid,
      board: 'backlog',
      source: 'o1',
      name: 'Bitte anbieten',
      assignees: '',
      priority: 'low',
      owner: ME,
      watchers: [ME],
      mentions: [],
      mentionsComment: [],
      updatedAt: NOW,
      createdAt: NOW,
      assignedAt: '',
      externalId: expect.stringMatching(/^[-0-9A-Za-z_]{20}$/),
      number: 'GA-5',
      rank: 'a1'
    })
    expect(Object.keys(patch?.body ?? {}).sort()).toEqual(
      [`externalIds/${task?.externalId}`, `taskBoards/o1/boards/0/tasks/${uid}`].sort()
    )
    expect(fw.externalIds[String(task?.externalId)]).toEqual({ source: uid, workspace: WS })
    expect(result.body).toMatchObject({ number: 'GA-5', board: 'backlog', retries: 0 })
  })

  it('takes board, due date, priority, a description with mentions and assignees by email', async () => {
    const { h, fw } = await setup()
    const result = await call(h, CREATE_TASK, {
      source: 'o1',
      board: 'progress',
      name: 'Check',
      summary: '<p><span data-mention-id="u-am">@am</span> please</p>',
      dueDate: '2027-02-01',
      priority: 'high',
      assignees: ['am@b.ch', ME, 'u-am']
    })
    expect(result.isError).toBe(false)
    const task = Object.values(tasksOn(fw, 'o1', 1)).find((item) => item?.name === 'Check')
    expect(task).toMatchObject({
      board: 'progress',
      dueDate: '2027-02-01',
      priority: 'high',
      assignees: ['u-am', ME],
      assignedAt: { 'u-am': NOW, [ME]: NOW },
      mentions: ['u-am'],
      rank: 'a6'
    })
  })

  it('without a prefix the number is the plain counter', async () => {
    const { h } = await setup()
    const result = await call(h, CREATE_TASK, { source: 'p1', name: 'X' })
    expect(result.body.number).toBe('1')
  })

  it('with invoice links the task and raises the invoice task count', async () => {
    const { h, fw, world } = await setup()
    const result = await call(h, CREATE_TASK, { source: 'p1', name: 'Pay', invoice: 'inv1' })
    expect(result.isError).toBe(false)
    const task = Object.values(tasksOn(fw, 'p1', 0)).find((item) => item?.name === 'Pay')
    expect(task?.node).toEqual({ uid: 'inv1', path: 'invoices/p1' })
    const invoices = fw.rtdb[WS]?.invoices as Record<string, Record<string, { tasks: number }>> | undefined
    expect(invoices?.p1?.inv1?.tasks).toBe(3)
    expect(sentBodies(world).map((write) => `${write.method} ${write.path}`)).toEqual([
      'PUT taskBoards/p1/taskCounter',
      'PATCH ',
      'PUT invoices/p1/inv1/tasks'
    ])
    expect(result.body.invoiceTasks).toBe(3)
  })

  it.each([
    [
      { source: 'o1', name: 'X', board: 'review' },
      'Board "review" is not a task board of o1. Boards: backlog, progress, finished'
    ],
    [{ source: 'o1', name: 'X', board: 'archived' }, 'do not archive tasks'],
    [{ source: 'nope', name: 'X' }, 'has no task boards'],
    [{ source: 'o1', name: 'X', assignees: ['stranger@x.ch'] }, 'no Campaigns user'],
    [{ source: 'p1', name: 'X', invoice: 'inv9' }, 'Invoice "inv9" does not exist']
  ])('refuses %o before any write', async (args, text) => {
    const { h, world } = await setup()
    await refusedWithoutWrites(h, world, CREATE_TASK, args, text)
  })

  it.each([CREATE_TASK, UPDATE_TASK])('%s refuses the task board of an archived project or offer', async (tool) => {
    const { h, fw, world } = await setup()
    ;(fw.rtdb[WS]?.planner as Record<string, Record<string, unknown>>).o1 = {
      uid: 'o1',
      name: 'Gala',
      owner: 'boss',
      archived: true
    }
    const args = tool === CREATE_TASK ? { source: 'o1', name: 'X' } : { source: 'o1', task: 't1', name: 'X' }
    await refusedWithoutWrites(h, world, tool, args, 'is archived')
  })

  it('refuses a task board of a project hidden from the caller', async () => {
    const { h, fw, world } = await setup()
    ;(fw.rtdb[WS]?.taskBoards as Record<string, unknown>).p3 = { prefix: 'S', taskCounter: 0, boards: boards() }
    await refusedWithoutWrites(h, world, CREATE_TASK, { source: 'p3', name: 'X' }, 'hidden from you')
  })

  it('refuses an unknown priority or a bad due date by the schema', async () => {
    const { h, world } = await setup()
    await expect(call(h, CREATE_TASK, { source: 'o1', name: 'X', priority: 'urgent' })).rejects.toThrow('MCP error')
    await expect(call(h, CREATE_TASK, { source: 'o1', name: 'X', dueDate: '2027-02-30' })).rejects.toThrow('MCP error')
    expect(writes(world)).toEqual([])
  })

  it('with personal data off a description or assignees are refused', async () => {
    const { h, world } = await setup({ allowPersonalData: false })
    await refusedWithoutWrites(h, world, CREATE_TASK, { source: 'o1', name: 'X', summary: 'y' }, 'summary')
    await refusedWithoutWrites(h, world, CREATE_TASK, { source: 'o1', name: 'X', assignees: [ME] }, 'assignees')
  })

  it('needs one of the task manage permissions', async () => {
    const { h, world } = await setup({ permissions: ['campaigns_app:view'] })
    await refusedWithoutWrites(h, world, CREATE_TASK, { source: 'o1', name: 'X' }, 'campaigns_app/tasks:manage or')
  })

  const LEAD_BOARD = { uid: 'd1', prefix: 'L', taskCounter: 0, boards: boards() }
  it.each<[string, string, string | null]>([
    ['campaigns_app/offers/tasks:manage', 'p1', 'campaigns_app/projects/tasks:manage or campaigns_app/tasks:manage'],
    ['campaigns_app/leads/tasks:manage', 'o1', 'campaigns_app/offers/tasks:manage or campaigns_app/tasks:manage'],
    ['campaigns_app/projects/tasks:manage', 'd1', 'campaigns_app/leads/tasks:manage or campaigns_app/tasks:manage'],
    ['campaigns_app/projects/tasks:manage', 'p1', null],
    ['campaigns_app/offers/tasks:manage', 'o1', null],
    ['campaigns_app/leads/tasks:manage', 'd1', null],
    ['campaigns_app/tasks:manage', 'p1', null]
  ])('with only %s, a task on %s needs the permission of the source type', async (permission, source, missing) => {
    const { h, fw, world } = await setup({ permissions: ['campaigns_app:view', permission] })
    ;(fw.rtdb[WS]?.taskBoards as Record<string, unknown>).d1 = LEAD_BOARD
    if (missing !== null) {
      await refusedWithoutWrites(h, world, CREATE_TASK, { source, name: 'X' }, missing)
      return
    }
    expect((await call(h, CREATE_TASK, { source, name: 'X' })).isError).toBe(false)
  })

  it('campaigns_update_task also needs the permission of the source type', async () => {
    const { h, world } = await setup({ permissions: ['campaigns_app:view', 'campaigns_app/leads/tasks:manage'] })
    await refusedWithoutWrites(h, world, UPDATE_TASK, { source: 'o1', task: 't1', name: 'X' }, 'offers/tasks:manage')
  })

  it('counter race: a counter changed by someone else is read again and the task gets the next number', async () => {
    const { h, fw } = await setup()
    let raced = false
    fw.beforeWrite = (method, path) => {
      if (!raced && method === 'PUT' && path.endsWith('taskBoards/o1/taskCounter')) {
        raced = true
        const node = taskBoard(fw, 'o1')
        if (node) node.taskCounter = 5
      }
    }
    const result = await call(h, CREATE_TASK, { source: 'o1', name: 'Second' })
    expect(result.isError).toBe(false)
    expect(result.body).toMatchObject({ number: 'GA-6', retries: 1 })
    expect(taskBoard(fw, 'o1')?.taskCounter).toBe(6)
  })

  it('preview sends no write and returns the planned writes', async () => {
    const { h, fw, world } = await setup()
    const result = await call(h, CREATE_TASK, { source: 'o1', name: 'X', preview: true })
    expect(result.isError).toBe(false)
    expect(writes(world)).toEqual([])
    expect(taskBoard(fw, 'o1')?.taskCounter).toBe(4)
    expect((result.body.writes as Array<{ method: string }>).map((write) => write.method)).toEqual(['PUT', 'PATCH'])
  })
})

describe('campaigns_update_task (S7, AC-7.5)', () => {
  it('on the same board writes only the given fields, mentions, assignedAt, updatedBy and updatedAt', async () => {
    const { h, fw, world } = await setup()
    const result = await call(h, UPDATE_TASK, { source: 'o1', task: 't1', name: 'Book hall', priority: 'medium' })
    expect(result.isError).toBe(false)
    const base = 'taskBoards/o1/boards/0/tasks/t1'
    expect(sentBodies(world)).toEqual([
      {
        method: 'PATCH',
        path: '',
        body: {
          [`${base}/name`]: 'Book hall',
          [`${base}/priority`]: 'medium',
          [`${base}/mentions`]: [],
          [`${base}/assignedAt`]: { 'u-am': '2027-01-01T00:00:00.000Z' },
          [`${base}/updatedBy`]: ME,
          [`${base}/updatedAt`]: NOW
        }
      }
    ])
    expect(tasksOn(fw, 'o1', 0).t1).toMatchObject({ name: 'Book hall', owner: 'boss', number: 'GA-3' })
    expect(result.body).toMatchObject({ changed: ['name', 'priority'], board: { from: 'backlog', to: 'backlog' } })
  })

  it('new assignees keep the old assignedAt and get now; [] clears them', async () => {
    const { h, fw } = await setup()
    await call(h, UPDATE_TASK, { source: 'o1', task: 't1', assignees: ['u-am', 'frank@colada.test'] })
    expect(tasksOn(fw, 'o1', 0).t1).toMatchObject({
      assignees: ['u-am', ME],
      assignedAt: { 'u-am': '2027-01-01T00:00:00.000Z', [ME]: NOW }
    })
    await call(h, UPDATE_TASK, { source: 'o1', task: 't1', assignees: [] })
    expect(tasksOn(fw, 'o1', 0).t1).toMatchObject({ assignees: '', assignedAt: '' })
  })

  it('a move to a final board removes it from the old board in the same write, at the end, with finishedAt', async () => {
    const { h, fw, world } = await setup()
    const result = await call(h, UPDATE_TASK, { source: 'o1', task: 't1', board: 'finished', dueDate: '2027-03-01' })
    expect(result.isError).toBe(false)
    const sent = sentBodies(world)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.body['taskBoards/o1/boards/0/tasks/t1']).toBeNull()
    expect(tasksOn(fw, 'o1', 0).t1 ?? null).toBeNull()
    expect(sent[0]?.body['taskBoards/o1/boards/2/tasks/t1']).toEqual({
      ...boards()[0]?.tasks?.t1,
      dueDate: '2027-03-01',
      board: 'finished',
      rank: 'a0',
      mentions: [],
      mentionsComment: ['u-am'],
      updatedBy: ME,
      updatedAt: NOW,
      finishedAt: NOW,
      finishedBy: ME
    })
    expect(tasksOn(fw, 'o1', 2).t1).toMatchObject({ board: 'finished', finishedBy: ME })
    expect(result.body).toMatchObject({ board: { from: 'backlog', to: 'finished' } })
  })

  it('a move to a non-final board sets no finishedAt and ranks after the last task', async () => {
    const { h, fw } = await setup()
    await call(h, UPDATE_TASK, { source: 'o1', task: 't1', board: 'progress' })
    const moved = tasksOn(fw, 'o1', 1).t1
    expect(moved).toMatchObject({ board: 'progress', rank: 'a6' })
    expect(moved).not.toHaveProperty('finishedAt')
  })

  it.each([
    [{ source: 'o1', task: 't1' }, 'Pass at least one field'],
    [{ source: 'o1', task: 'nope', name: 'X' }, 'Task "nope" is not on the task boards of o1'],
    [{ source: 'o1', task: 't2', name: 'X' }, 'is archived'],
    [{ source: 'o1', task: 't1', board: 'archived' }, 'do not archive tasks'],
    [{ source: 'o1', task: 't1', board: 'review' }, 'Board "review"'],
    [{ source: 'o1', task: 't1', assignees: ['stranger@x.ch'] }, 'no Campaigns user']
  ])('refuses %o before any write', async (args, text) => {
    const { h, world } = await setup()
    await refusedWithoutWrites(h, world, UPDATE_TASK, args, text)
  })

  const ws = `workspaces/${WS}`
  const t = (board: number, key: string) => `${ws}/taskBoards/o1/boards/${board}/tasks/${key}`
  const ctx = { workspace: WS, uid: ME, checkedUsers: new Set(['boss']) }
  it.each<[string, Record<string, unknown>]>([
    ['a null alone', { [t(0, 't1')]: null }],
    ['a null on the same board', { [t(0, 't1')]: null, [t(0, 't1x')]: { uid: 't1x' } }],
    ['a null with a task of another uid', { [t(0, 't1')]: null, [t(2, 't1')]: { uid: 'other' } }],
    ['a null with a field write', { [t(0, 't1')]: null, [`${t(2, 't1')}/name`]: 'x' }]
  ])('the policy refuses %s as X5', (_name, body) => {
    expect(writeRefusal(UPDATE_TASK, { method: 'PATCH', path: '', body }, ctx)).toBe('X5')
  })

  it('the policy allows a move pair, and the kept owner only when checked', () => {
    const body = { [t(0, '0')]: null, [t(2, 't1')]: { uid: 't1', owner: 'boss', updatedBy: ME } }
    expect(writeRefusal(UPDATE_TASK, { method: 'PATCH', path: '', body }, ctx)).toBeNull()
    expect(writeRefusal(UPDATE_TASK, { method: 'PATCH', path: '', body }, { workspace: WS, uid: ME })).toBe('X7')
    expect(writeRefusal(CREATE_TASK, { method: 'PATCH', path: '', body }, ctx)).toBe('X5')
  })
})

describe('prod gate for the new campaigns_* writes (AC-7.6)', () => {
  it.each<[string, Record<string, unknown>]>([
    [UPDATE_PROJECT, { project: 'p1', status: 'paid' }],
    [CREATE_TASK, { source: 'o1', name: 'X' }],
    [UPDATE_TASK, { source: 'o1', task: 't1', name: 'X' }]
  ])('%s without a valid previewId is refused before any read or write', async (tool, args) => {
    const { h, world } = await setup({ host: PROD_HOST })
    for (const extra of [{}, { previewId: 'made-up' }]) {
      const result = await call(h, tool, { ...args, ...extra })
      expect(result.isError).toBe(true)
      expect(result.body.error).toContain('needs a preview first')
    }
    expect(rtdbRequests(world)).toEqual([])
    const preview = await call(h, tool, { ...args, preview: true })
    expect(writes(world)).toEqual([])
    const real = await call(h, tool, { ...args, previewId: preview.body.previewId })
    expect(real.isError).toBe(false)
    expect(writes(world).length).toBeGreaterThan(0)
  })
})
