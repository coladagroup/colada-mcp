import { afterEach, describe, expect, it } from 'vitest'
import { inputHash, isProdHost } from '../src/preview.js'
import { firebaseSetup, firestoreRequests, ME, rtdbRequests } from './firebaseFake.js'
import { createHarness, FakeWorld, fakeUser, type Harness, json, STAGE_HOST, WS_A, WS_B, workspace } from './harness.js'

const WS = WS_A
const PROD_HOST = 'admin.colada365.com'
const CUSTOMER_HOST = 'events.customer-fair.ch'
const PERMISSIONS = [
  'campaigns_app:view',
  'campaigns_app/offers:manage',
  'campaigns_app/offers/settings:manage',
  'campaigns_app/offers/budget:manage',
  'campaigns_app/leads:manage',
  'campaigns_app/timesheet/me:manage'
]
const RANDOM_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[-0-9A-Za-z_]{20}/g
const RESOURCE = '/_gw/s-events-resources/api/events/e1/resources/r1'
const REALM_CONFIG = '/_gw/s-ecosystem/oauthclients/colada-mcp/config'

const T1 = {
  uid: 't1',
  owner: ME,
  date: '2026-09-02',
  hours: 2,
  minutes: 0,
  project: 'p1',
  entity: 'r1',
  account: 'a1'
}

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

async function setup(host = STAGE_HOST, allowPersonalData = true) {
  const result = await firebaseSetup({ host, allowPersonalData })
  harnesses.push(result.h)
  result.fw.permissions = PERMISSIONS
  result.fw.world.users.set(WS, [fakeUser(ME, 'frank@colada.test'), fakeUser('u-pm', 'pm@b.ch')])
  result.fw.rtdb[WS] = {
    projectCounter: 41,
    planner: {
      o2: { uid: 'o2', name: 'New', currency: 'CHF', owner: 'boss' },
      o1: {
        uid: 'o1',
        name: 'Gala',
        client: 'c1',
        status: 'qualified',
        startDate: '2027-03-01T09:00',
        endDate: '2027-03-02T18:00',
        currency: 'CHF',
        owner: 'boss',
        archived: false,
        externalId: 'ext-o1',
        number: '2026-007',
        total: 1000,
        allocated: 0
      }
    },
    plannerBudgets: {
      o1: [
        { uid: 'r1', name: 'Venue', content: { price: 1000, selectedQuantity: 1 } },
        { uid: 'r2', name: 'Catering', content: { price: 20, selectedQuantity: 10 } }
      ],
      o2: [{ uid: 'blank', name: '', content: { price: 0, selectedQuantity: 1 } }]
    },
    deals: {
      o1: { uid: 'o1', name: 'Gala', status: 'qualified', owner: 'boss' },
      d2: { uid: 'd2', name: 'Lead two', client: 'c2', status: 'negotiation', owner: 'boss', externalId: 'ext-d2' }
    },
    taskBoards: { d2: { uid: 'd2', prefix: 'LT', boards: [{ id: 'backlog' }], taskCounter: 0 } },
    costCenters: { list: [{ uid: 'cc1', name: 'HQ' }], updatedAt: '2026-10-01T10:00:00.000Z' },
    timesheet: { t1: T1 },
    projects: { p1: { uid: 'p1', name: 'Fair', owner: 'boss', deputies: [ME] } },
    budgets: { p1: [{ uid: 'r1', name: 'Room', content: { price: 10, reports: { '2026-09-02': [T1] } } }] }
  }
  return result
}

type World = Awaited<ReturnType<typeof setup>>['world']

const writeRequests = (world: World) => rtdbRequests(world).filter((request) => request.method !== 'GET')

function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value).replace(RANDOM_ID, '<id>'))
}

function sentWrites(world: World) {
  const prefix = `workspaces/${WS}/`
  return normalize(
    writeRequests(world).map((request) => {
      const raw = request.url.pathname.slice(1).replace(/\.json$/, '')
      const path = raw === '' ? '/' : raw.replace(prefix, '')
      const parsed = JSON.parse(String(request.body)) as unknown
      const body =
        path === '/'
          ? Object.fromEntries(
              Object.entries(parsed as Record<string, unknown>).map(([key, item]) => [
                key.startsWith(prefix) ? key.slice(prefix.length) : `/${key}`,
                item
              ])
            )
          : parsed
      return {
        method: request.method,
        path,
        ...(request.headers['if-match'] === undefined ? {} : { ifMatch: true }),
        body
      }
    })
  )
}

const CASES: Array<{ tool: string; input: Record<string, unknown> }> = [
  {
    tool: 'campaigns_create_offer',
    input: { name: 'Spring Fair', client: 'c9', startDate: '2027-05-10T08:00', endDate: '2027-05-12T17:30' }
  },
  { tool: 'campaigns_update_offer', input: { offer: 'o1', name: 'Gala 2027', costCenter: 'cc1' } },
  { tool: 'campaigns_create_lead', input: { name: 'New lead', accountManager: 'pm@b.ch' } },
  {
    tool: 'campaigns_add_budget_rows',
    input: { offer: 'o1', rows: [{ type: 'free', name: 'Transport', price: 250, q1: 2 }] }
  },
  {
    tool: 'campaigns_add_timesheet_report',
    input: { date: '2026-09-03', hours: 1, project: 'p1', entity: 'r1', account: 'a1' }
  },
  { tool: 'campaigns_update_timesheet_report', input: { key: 't1', hours: 3 } },
  { tool: 'campaigns_update_lead', input: { lead: 'o1', name: 'Gala 2028', status: 'offered' } },
  { tool: 'campaigns_update_budget_row', input: { offer: 'o1', row: 'r2', price: 25, parentRow: '', position: 0 } },
  { tool: 'campaigns_remove_budget_rows', input: { offer: 'o1', rows: ['r1'] } },
  {
    tool: 'campaigns_add_budget_rows',
    input: { offer: 'o2', replaceBlankRow: true, rows: [{ type: 'free', name: 'Room', price: 100 }] }
  }
]

const NEW_TOOLS = CASES.slice(6)

describe('preview of campaigns_* writes (AC-6.6)', () => {
  it.each(CASES)('$tool: preview sends nothing and shows the writes a real call sends', async ({ tool, input }) => {
    const { h, world } = await setup()
    const preview = await h.call(tool, { workspace: WS, ...input, preview: true })

    expect(preview.isError).toBe(false)
    expect(writeRequests(world)).toEqual([])
    expect(preview.body).toMatchObject({ preview: true, note: expect.stringContaining('nothing was sent') })
    expect(preview.body.previewId).toEqual(expect.any(String))
    expect((preview.body.result as Record<string, unknown>).written).toBeUndefined()
    expect((preview.body.writes as unknown[]).length).toBeGreaterThan(0)

    const real = await h.call(tool, { workspace: WS, ...input })

    expect(real.isError).toBe(false)
    expect(normalize(preview.body.writes)).toEqual(sentWrites(world))
    const { written: _written, ...realResult } = real.body as Record<string, unknown>
    for (const key of ['realm', 'user', 'workspace', 'notice']) delete realResult[key]
    expect(normalize(preview.body.result)).toEqual(normalize(realResult))
  })

  it('without personal data a preview hides stored personal fields in the writes', async () => {
    const { h, fw } = await setup(STAGE_HOST, false)
    const rtdb = fw.rtdb[WS] as Record<string, Record<string, unknown>>
    const withNote = { ...T1, description: 'Secret note' }
    rtdb.timesheet = { t1: withNote }
    rtdb.budgets = { p1: [{ uid: 'r1', name: 'Room', content: { price: 10, reports: { '2026-09-02': [withNote] } } }] }
    rtdb.plannerBudgets = {
      o1: [
        { uid: 'r1', name: 'Venue', content: { price: 1000, invoices: [{ supplier: 'Secret supplier', amount: 5 }] } },
        { uid: 'r2', name: 'Catering', content: { price: 20, selectedQuantity: 10 } }
      ]
    }

    for (const [tool, input] of [
      ['campaigns_update_timesheet_report', { key: 't1', hours: 3 }],
      ['campaigns_update_budget_row', { offer: 'o1', row: 'r2', price: 25 }]
    ] as const) {
      const preview = await h.call(tool, { workspace: WS, ...input, preview: true })
      expect(preview.isError).toBe(false)
      expect(JSON.stringify(preview.body)).not.toContain('Secret')
    }
  })

  it('a preview logs outcome preview with the planned paths and no HTTP status', async () => {
    const { h } = await setup()
    await h.call('campaigns_add_budget_rows', {
      workspace: WS,
      offer: 'o1',
      rows: [{ type: 'free', name: 'Transport', price: 250 }],
      preview: true
    })
    const lines = h.logs.filter((line) => line.tool === 'campaigns_add_budget_rows')
    expect(
      lines.map((line) => [line.outcome, line.reason, line.httpStatus, 'path' in line ? line.path : null])
    ).toEqual([
      ['preview', null, null, 'plannerBudgets/o1'],
      ['preview', null, null, '/']
    ])
  })

  it('a preview still runs the policy and the permission check', async () => {
    const { h, fw, world } = await setup()
    fw.permissions = ['campaigns_app:view']
    const result = await h.call('campaigns_update_offer', { workspace: WS, offer: 'o1', name: 'X', preview: true })
    expect(result.isError).toBe(true)
    expect(result.body.error).toContain('campaigns_app/offers/settings:manage')
    expect(writeRequests(world)).toEqual([])
    expect(h.logs.at(-1)).toMatchObject({ outcome: 'refused', reason: 'writeMissingPermission' })
  })

  it('a timesheet entry moved to another date: preview equals the real writes', async () => {
    const { h, world } = await setup()
    const preview = await h.call('campaigns_update_timesheet_report', {
      workspace: WS,
      key: 't1',
      date: '2026-09-04',
      preview: true
    })
    expect(preview.isError).toBe(false)
    expect(writeRequests(world)).toEqual([])
    await h.call('campaigns_update_timesheet_report', { workspace: WS, key: 't1', date: '2026-09-04' })
    expect(normalize(preview.body.writes)).toEqual(sentWrites(world))
  })
})

describe('prod gate for campaigns_* writes (AC-6.6a)', () => {
  const input = { workspace: WS, offer: 'o1', name: 'Gala 2027' }
  const tool = 'campaigns_update_offer'

  function dataRequests(world: World) {
    return [
      ...rtdbRequests(world),
      ...firestoreRequests(world),
      ...world.backendRequests().filter((request) => request.url.pathname !== REALM_CONFIG)
    ]
  }

  async function refusedBeforeAnyRead(h: Harness, world: World, args: Record<string, unknown>, otherTool = tool) {
    const before = dataRequests(world).length
    const result = await h.call(otherTool, args)
    expect(result.isError).toBe(true)
    expect(result.body.error).toContain('needs a preview first')
    expect(dataRequests(world).length).toBe(before)
    expect(h.logs.at(-1)).toMatchObject({ outcome: 'refused', reason: 'previewRequired', method: null })
  }

  it.each([PROD_HOST, CUSTOMER_HOST])('on %s a call without previewId is refused before any read', async (host) => {
    const { h, world } = await setup(host)
    await refusedBeforeAnyRead(h, world, input)
    expect(dataRequests(world)).toEqual([])
  })

  it('an unknown previewId is refused', async () => {
    const { h, world } = await setup(PROD_HOST)
    await refusedBeforeAnyRead(h, world, { ...input, previewId: 'made-up' })
  })

  it('a valid previewId runs the call once; the second use is refused', async () => {
    const { h, world } = await setup(PROD_HOST)
    const preview = await h.call(tool, { ...input, preview: true })
    expect(preview.isError).toBe(false)
    expect(writeRequests(world)).toEqual([])

    const real = await h.call(tool, { ...input, previewId: preview.body.previewId })
    expect(real.isError).toBe(false)
    expect(writeRequests(world)).toHaveLength(1)

    await refusedBeforeAnyRead(h, world, { ...input, previewId: preview.body.previewId })
    expect(writeRequests(world)).toHaveLength(1)
  })

  it('a previewId expires after 10 minutes', async () => {
    const { h, world } = await setup(PROD_HOST)
    const preview = await h.call(tool, { ...input, preview: true })
    world.now += 600
    const atLimit = await h.call(tool, { ...input, previewId: preview.body.previewId })
    expect(atLimit.isError).toBe(false)

    const second = await h.call(tool, { ...input, name: 'Gala 2028', preview: true })
    world.now += 601
    await refusedBeforeAnyRead(h, world, { ...input, name: 'Gala 2028', previewId: second.body.previewId })
  })

  it('a previewId of another tool is refused', async () => {
    const { h, world } = await setup(PROD_HOST)
    const preview = await h.call('campaigns_create_lead', { workspace: WS, name: 'Lead', preview: true })
    await refusedBeforeAnyRead(h, world, { ...input, previewId: preview.body.previewId })
  })

  it('a previewId for a changed field, another workspace or an added field is refused', async () => {
    const { h, world } = await setup(PROD_HOST)
    const preview = await h.call(tool, { ...input, preview: true })
    const previewId = preview.body.previewId
    await refusedBeforeAnyRead(h, world, { ...input, name: 'Gala 2028', previewId })
    await refusedBeforeAnyRead(h, world, { ...input, workspace: WS_B, previewId })
    await refusedBeforeAnyRead(h, world, { ...input, status: 'offered', previewId })
    const real = await h.call(tool, { ...input, previewId })
    expect(real.isError).toBe(false)
  })

  describe.each(NEW_TOOLS)('new tool $tool', ({ tool: newTool, input: newInput }) => {
    const args = { workspace: WS, ...newInput }

    it('is refused on a prod host without a valid previewId, and runs once with one', async () => {
      const { h, world } = await setup(PROD_HOST)
      await refusedBeforeAnyRead(h, world, args, newTool)
      await refusedBeforeAnyRead(h, world, { ...args, previewId: 'made-up' }, newTool)

      const other = await h.call('campaigns_create_lead', { workspace: WS, name: 'Lead', preview: true })
      await refusedBeforeAnyRead(h, world, { ...args, previewId: other.body.previewId }, newTool)

      const changed = await h.call(newTool, { ...args, preview: true })
      await refusedBeforeAnyRead(
        h,
        world,
        { ...args, ...('lead' in args ? { lead: 'o9' } : { offer: 'o9' }), previewId: changed.body.previewId },
        newTool
      )

      const expired = await h.call(newTool, { ...args, preview: true })
      world.now += 601
      await refusedBeforeAnyRead(h, world, { ...args, previewId: expired.body.previewId }, newTool)

      const preview = await h.call(newTool, { ...args, preview: true })
      expect(preview.isError).toBe(false)
      expect(writeRequests(world)).toEqual([])
      const real = await h.call(newTool, { ...args, previewId: preview.body.previewId })
      expect(real.isError).toBe(false)
      const sent = writeRequests(world).length
      expect(sent).toBeGreaterThan(0)
      await refusedBeforeAnyRead(h, world, { ...args, previewId: preview.body.previewId }, newTool)
      expect(writeRequests(world)).toHaveLength(sent)
    })

    it('runs on a stage host without previewId', async () => {
      const { h } = await setup(STAGE_HOST)
      const real = await h.call(newTool, args)
      expect(real.isError).toBe(false)
    })
  })

  it('on a stage host the call runs without previewId', async () => {
    const { h, world } = await setup(STAGE_HOST)
    const real = await h.call(tool, input)
    expect(real.isError).toBe(false)
    expect(writeRequests(world)).toHaveLength(1)
  })
})

describe('preview helpers', () => {
  it('a host is prod unless it starts with stage-', () => {
    expect(isProdHost('stage-admin.colada365.com')).toBe(false)
    expect(isProdHost('stage-lidl.example.com')).toBe(false)
    expect(isProdHost('admin.colada365.com')).toBe(true)
    expect(isProdHost('lidl-football-hub.com')).toBe(true)
    expect(isProdHost('admin-stage.colada365.com')).toBe(true)
  })

  it('the input hash ignores key order, undefined fields, preview and previewId', () => {
    const base = inputHash('t', { a: 1, b: { c: 2, d: 3 } })
    expect(inputHash('t', { b: { d: 3, c: 2 }, a: 1, e: undefined, preview: true, previewId: 'x' })).toBe(base)
    expect(inputHash('t', { a: 1, b: { c: 2, d: 4 } })).not.toBe(base)
    expect(inputHash('u', { a: 1, b: { c: 2, d: 3 } })).not.toBe(base)
    expect(inputHash('t', { a: 1, b: { c: 2, d: 3 }, rows: [1, 2] })).not.toBe(
      inputHash('t', { a: 1, b: { c: 2, d: 3 }, rows: [2, 1] })
    )
  })
})

describe('api_write preview (AC-6.6)', () => {
  async function apiSetup(host = STAGE_HOST) {
    const world = new FakeWorld()
    world.addRealm(host, {
      user: 'frank',
      members: [WS_A, WS_B],
      workspaces: [workspace(WS_A, 'Alpha'), workspace(WS_B, 'Beta')]
    })
    const h = await createHarness(world, [host])
    world.seedRefreshToken(host, h.store)
    harnesses.push(h)
    world.backendRaw.set(RESOURCE, () => json(200, { id: 'r1' }, { ETag: 'rev-2' }))
    return h
  }
  const input = {
    workspace: WS_A,
    method: 'put',
    service: 's-events-resources',
    path: '/api/events/e1/resources/r1',
    query: { notify: 'false' },
    headers: { 'If-Match': '7' },
    body: { title: 'New title' }
  }
  const sent = (h: Harness) => h.world.backendRequests().filter((request) => request.url.pathname === RESOURCE)

  it('returns the request a real call sends and sends nothing', async () => {
    const h = await apiSetup()
    const preview = await h.call('api_write', { ...input, preview: true })
    expect(preview.isError).toBe(false)
    expect(sent(h)).toEqual([])
    expect(h.logs.at(-1)).toMatchObject({ tool: 'api_write', method: 'PUT', outcome: 'preview', httpStatus: null })

    const real = await h.call('api_write', input)
    expect(real.isError).toBe(false)
    const [request] = sent(h)
    expect(preview.body.request).toEqual({
      method: request?.method,
      host: request?.url.host,
      service: 's-events-resources',
      path: '/api/events/e1/resources/r1',
      query: Object.fromEntries(request?.url.searchParams ?? []),
      headers: ['If-Match'],
      body: JSON.parse(String(request?.body))
    })
    expect(request?.headers['if-match']).toBe('7')
  })

  it('runs the policy: a blocked route is refused in preview too', async () => {
    const h = await apiSetup()
    const result = await h.call('api_write', { ...input, method: 'DELETE', preview: true })
    expect(result.isError).toBe(true)
    expect(h.logs.at(-1)).toMatchObject({ outcome: 'refused' })
    expect(sent(h)).toEqual([])
  })

  it('takes no write budget: 60 previews, then a real write succeeds', async () => {
    const h = await apiSetup()
    for (let i = 0; i < 60; i++) {
      const preview = await h.call('api_write', { ...input, preview: true })
      expect(preview.isError).toBe(false)
    }
    const real = await h.call('api_write', input)
    expect(real.isError).toBe(false)
    expect(sent(h)).toHaveLength(1)
  })

  it('the budget is real: 60 real writes, then the next one is refused', async () => {
    const h = await apiSetup()
    for (let i = 0; i < 60; i++) await h.call('api_write', input)
    const over = await h.call('api_write', input)
    expect(over.isError).toBe(true)
    expect(h.logs.at(-1)).toMatchObject({ reason: 'writeBudget' })
  })

  it('needs no previewId on a prod host', async () => {
    const h = await apiSetup(PROD_HOST)
    const real = await h.call('api_write', input)
    expect(real.isError).toBe(false)
    expect(sent(h)).toHaveLength(1)
  })
})
