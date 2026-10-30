import { afterEach, describe, expect, it } from 'vitest'
import { firebaseSetup, ME, rtdbRequests } from './firebaseFake.js'
import { type Harness, WS_A } from './harness.js'

const WS = WS_A
const CREATE = 'campaigns_create_offer'
const UPDATE = 'campaigns_update_offer'
const LEAD = 'campaigns_create_lead'
const NOW_JSON = '2027-01-15T08:00:00.000Z'
const ALL = [
  'campaigns_app:view',
  'campaigns_app/offers:manage',
  'campaigns_app/offers/settings:manage',
  'campaigns_app/leads:manage'
]
const KEY = /^[-0-9A-Za-z_]{20}$/

const O1 = {
  uid: 'o1',
  name: 'Gala',
  client: 'c1',
  person: 'k1',
  status: 'qualified',
  location: 'L1',
  rooms: ['R1'],
  startDate: '2027-03-01T09:00',
  endDate: '2027-03-02T18:00',
  currency: 'CHF',
  owner: 'boss',
  archived: false,
  externalId: 'ext-o1',
  number: '2026-007',
  total: 120
}
const D2 = {
  uid: 'd2',
  name: 'Lead two',
  contact: 'k2',
  client: 'c2',
  status: 'negotiation',
  chance: '50%',
  owner: 'boss',
  archived: false,
  externalId: 'ext-d2'
}

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

async function setup(options: { allowPersonalData?: boolean; permissions?: string[] } = {}) {
  const result = await firebaseSetup({ allowPersonalData: options.allowPersonalData })
  harnesses.push(result.h)
  result.fw.permissions = options.permissions ?? ALL
  result.fw.rtdb[WS] = {
    projectCounter: 41,
    planner: {
      o1: O1,
      o2: { ...O1, uid: 'o2', archived: true },
      o3: { ...O1, uid: 'o3', isPrivate: 'true' },
      o4: { ...O1, uid: 'o4', startDate: '2027-03-01', endDate: '2027-03-01' },
      d1: { ...O1, uid: 'd1' }
    },
    deals: {
      o1: { uid: 'o1', name: 'Gala', status: 'qualified', owner: 'boss', costCenter: 'cc1' },
      d1: { uid: 'd1', name: 'Has offer', owner: 'boss', externalId: 'ext-d1' },
      d2: D2
    },
    taskBoards: { d2: { uid: 'd2', prefix: 'LT', boards: [{ id: 'backlog' }], taskCounter: 0 } },
    costCenters: [{ uid: 'cc1', name: 'HQ', children: [{ uid: 'cc2', name: 'Sales' }] }],
    projects: { p1: { uid: 'p1', name: 'Fair', owner: 'boss' } }
  }
  return result
}

type Fw = Awaited<ReturnType<typeof setup>>['fw']

function node(fw: Fw, name: string): Record<string, Record<string, unknown>> {
  return (fw.rtdb[WS]?.[name] ?? {}) as Record<string, Record<string, unknown>>
}

const writes = (world: Parameters<typeof rtdbRequests>[0]) =>
  rtdbRequests(world).filter((request) => request.method !== 'GET')

function writeSummary(world: Parameters<typeof rtdbRequests>[0]) {
  return writes(world).map((request) => {
    const path = request.url.pathname.replace(`/workspaces/${WS}/`, '')
    if (request.method !== 'PATCH') return `${request.method} ${path}`
    return `PATCH ${path} ${Object.keys(JSON.parse(String(request.body))).join(' ')}`
  })
}

async function schemaText(h: Harness, name: string, args: Record<string, unknown>) {
  const result = await h.client.callTool({ name, arguments: { workspace: WS, ...args } })
  return { isError: result.isError === true, text: (result.content as Array<{ text: string }>)[0]?.text ?? '' }
}

const call = (h: Harness, name: string, args: Record<string, unknown>) => h.call(name, { workspace: WS, ...args })

const OFFER_INPUT = {
  name: 'Spring Fair',
  client: 'c9',
  startDate: '2027-05-10T08:00',
  endDate: '2027-05-12T17:30'
}

describe('campaigns_create_offer', () => {
  it('creates an offer without a lead as the app: counter PUT, then one root PATCH of new keys (AC-P1, P22, P30)', async () => {
    const { h, fw, world } = await setup()
    const result = await call(h, CREATE, { ...OFFER_INPUT, costCenter: 'cc2', status: 'calculation' })

    expect(result.isError).toBe(false)
    const id = result.body.id as string
    const externalId = result.body.externalId as string
    expect(id).toMatch(KEY)
    expect(externalId).toMatch(KEY)
    expect(externalId).not.toBe(id)
    expect(result.body.number).toBe('2027-042')
    expect(fw.rtdb[WS]?.projectCounter).toBe(42)
    expect(node(fw, 'planner')[id]).toEqual({
      ...OFFER_INPUT,
      status: 'calculation',
      costCenter: 'cc2',
      person: '',
      currency: 'CHF',
      eventsNum: 1,
      guests: 10,
      total: 0,
      archived: false,
      number: '2027-042',
      uid: id,
      externalId,
      createdAt: NOW_JSON,
      updatedAt: NOW_JSON,
      owner: ME
    })
    const rows = node(fw, 'plannerBudgets')[id] as unknown as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ uid: expect.any(String), name: '', content: { price: 0, selectedQuantity: 1 } })
    expect(node(fw, 'taskBoards')[id]).toEqual({
      uid: id,
      prefix: 'SF',
      boards: [{ id: 'backlog' }, { id: 'progress' }, { id: 'finished', final: true }, { id: 'archived' }],
      taskCounter: 0
    })
    expect(fw.externalIds[externalId]).toEqual({ source: id, workspace: WS })
    expect(writeSummary(world)).toEqual([
      'PUT projectCounter.json',
      `PATCH /.json workspaces/${WS}/planner/${id} workspaces/${WS}/plannerBudgets/${id} workspaces/${WS}/taskBoards/${id} externalIds/${externalId}`
    ])
    expect(writes(world)[0]?.headers['if-match']).toBeDefined()
    expect(result.body).toMatchObject({
      budgetRows: 1,
      taskBoards: 'scaffold',
      retries: 0,
      written: [
        { method: 'PUT', path: 'projectCounter' },
        { method: 'PATCH', path: '/' }
      ]
    })
  })

  it('a given prefix goes to taskBoards only, never to planner', async () => {
    const { h, fw } = await setup()
    const result = await call(h, CREATE, { ...OFFER_INPUT, prefix: 'SPR' })
    const id = result.body.id as string

    expect(node(fw, 'taskBoards')[id]?.prefix).toBe('SPR')
    expect(node(fw, 'planner')[id]).not.toHaveProperty('prefix')
  })

  it('creates an offer from a lead: lead id and externalId, taskBoards prefix only, nothing under deals or externalIds (AC-P2)', async () => {
    const { h, fw, world } = await setup()
    const result = await call(h, CREATE, { lead: 'd2', startDate: '2027-06-01T09:00', endDate: '2027-06-01T18:00' })

    expect(result.isError).toBe(false)
    expect(result.body).toMatchObject({ id: 'd2', externalId: 'ext-d2', number: '2027-042', taskBoards: 'prefix' })
    expect(node(fw, 'planner').d2).toEqual({
      name: 'Lead two',
      client: 'c2',
      person: 'k2',
      status: 'negotiation',
      startDate: '2027-06-01T09:00',
      endDate: '2027-06-01T18:00',
      currency: 'CHF',
      eventsNum: 1,
      guests: 10,
      costCenter: '',
      total: 0,
      archived: false,
      number: '2027-042',
      uid: 'd2',
      externalId: 'ext-d2',
      createdAt: NOW_JSON,
      updatedAt: NOW_JSON,
      owner: ME
    })
    expect(node(fw, 'taskBoards').d2).toEqual({ uid: 'd2', prefix: 'LT', boards: [{ id: 'backlog' }], taskCounter: 0 })
    expect(node(fw, 'deals').d2).toEqual(D2)
    expect(fw.externalIds).toEqual({})
    expect(writeSummary(world)).toEqual([
      'PUT projectCounter.json',
      `PATCH /.json workspaces/${WS}/planner/d2 workspaces/${WS}/plannerBudgets/d2 workspaces/${WS}/taskBoards/d2/prefix`
    ])
    expect(result.body.offer).not.toHaveProperty('person')
  })

  it('input fields win over the lead values', async () => {
    const { h, fw } = await setup()
    await call(h, CREATE, {
      lead: 'd2',
      name: 'Own name',
      status: 'offered',
      prefix: 'ON',
      startDate: '2027-06-01T09:00',
      endDate: '2027-06-01T18:00'
    })

    expect(node(fw, 'planner').d2).toMatchObject({ name: 'Own name', status: 'offered', client: 'c2' })
    expect(node(fw, 'taskBoards').d2?.prefix).toBe('ON')
  })

  it('two creates at the same time get different numbers (AC-P9)', async () => {
    const { h, fw } = await setup()
    const [a, b] = await Promise.all([call(h, CREATE, OFFER_INPUT), call(h, CREATE, OFFER_INPUT)])

    expect(a.isError).toBe(false)
    expect(b.isError).toBe(false)
    expect([a.body.number, b.body.number].sort()).toEqual(['2027-042', '2027-043'])
    expect(fw.rtdb[WS]?.projectCounter).toBe(43)
  })

  it('a counter changed by another user before the PUT is re-applied on the new value (P22, AC-P9)', async () => {
    const { h, fw } = await setup()
    let bumped = false
    fw.beforeWrite = (method, path) => {
      if (bumped || method !== 'PUT' || !path.endsWith('projectCounter')) return
      bumped = true
      ;(fw.rtdb[WS] as Record<string, unknown>).projectCounter = 42
    }
    const result = await call(h, CREATE, OFFER_INPUT)

    expect(result.body).toMatchObject({ number: '2027-043', retries: 1 })
    expect(fw.rtdb[WS]?.projectCounter).toBe(43)
  })

  it('a missing counter starts at 1, and numbers above 999 are not cut', async () => {
    const { h, fw } = await setup()
    delete (fw.rtdb[WS] as Record<string, unknown>).projectCounter
    expect((await call(h, CREATE, OFFER_INPUT)).body.number).toBe('2027-001')
    ;(fw.rtdb[WS] as Record<string, unknown>).projectCounter = 1233
    expect((await call(h, CREATE, OFFER_INPUT)).body.number).toBe('2027-1234')
  })

  it('a denied externalIds key fails the whole PATCH: no offer node is left, the number is reported as skipped', async () => {
    const { h, fw } = await setup()
    fw.beforeWrite = (method, _path, body) => {
      if (method !== 'PATCH') return
      for (const key of Object.keys(body as Record<string, unknown>)) {
        if (key.startsWith('externalIds/')) fw.externalIds[key.slice(12)] = { source: 'x', workspace: 'other-ws' }
      }
    }
    const result = await call(h, CREATE, OFFER_INPUT)

    expect(result.isError).toBe(true)
    expect(result.body.error).toContain(`${CREATE} stopped after a partial write. Saved: projectCounter.`)
    expect(result.body.error).toContain('Offer number 2027-042 is skipped')
    expect(Object.keys(node(fw, 'planner')).sort()).toEqual(['d1', 'o1', 'o2', 'o3', 'o4'])
    expect(fw.rtdb[WS]?.plannerBudgets).toBeUndefined()
    expect(Object.keys(node(fw, 'taskBoards'))).toEqual(['d2'])
  })

  it('refuses a lead that has an offer (E27) and a missing lead (E21) before any write', async () => {
    const { h, world } = await setup()
    const dates = { startDate: '2027-06-01T09:00', endDate: '2027-06-01T18:00' }

    expect((await call(h, CREATE, { lead: 'd1', ...dates })).body.error).toBe(
      'Lead d1 already has an offer (planner/d1).'
    )
    expect((await call(h, CREATE, { lead: 'nope', ...dates })).body.error).toBe(
      `Lead "nope" does not exist in workspace ${WS}. Nothing was written.`
    )
    expect(writes(world)).toEqual([])
  })

  it('refuses a missing cost center with E21; a nested one is found', async () => {
    const { h, world } = await setup()
    const result = await call(h, CREATE, { ...OFFER_INPUT, costCenter: 'cc7' })

    expect(result.body.error).toBe(`Cost center "cc7" does not exist in workspace ${WS}. Nothing was written.`)
    expect(writes(world)).toEqual([])
  })

  it('refuses missing required fields, bad dates and a start after the end with no Firebase request (P19, E22)', async () => {
    const { h, world } = await setup()
    const { client: _client, ...noClient } = OFFER_INPUT

    expect((await call(h, CREATE, noClient)).body.error).toBe(
      '"client" is required (from the input or the lead). Nothing was written.'
    )
    expect((await call(h, CREATE, { ...OFFER_INPUT, startDate: '2027-05-10' })).body.error).toBe(
      'startDate must be yyyy-MM-ddTHH:mm.'
    )
    expect((await call(h, CREATE, { ...OFFER_INPUT, endDate: '2027-05-09T10:00' })).body.error).toBe(
      'startDate is after endDate.'
    )
    expect(
      (await call(h, CREATE, { ...OFFER_INPUT, x_setup_start: '2027-05-09T10:00', x_setup_end: '2027-05-08T10:00' }))
        .body.error
    ).toBe('x_setup_start is after x_setup_end.')
    expect(rtdbRequests(world)).toEqual([])
  })

  it('refuses without offers:manage (E17) with no RTDB request (AC-P7)', async () => {
    const { h, world } = await setup({ permissions: ['campaigns_app:view', 'campaigns_app/offers:view'] })
    const result = await call(h, CREATE, OFFER_INPUT)

    expect(result.body.error).toBe(
      `You lack campaigns_app/offers:manage in workspace ${WS}, so ${CREATE} cannot write.`
    )
    expect(rtdbRequests(world)).toEqual([])
  })

  it('refuses notes, person and participants while the flag is off (E20, AC-P10)', async () => {
    const { h, world } = await setup()
    for (const [field, value] of [
      ['notes', 'call back'],
      ['person', 'k3'],
      ['participants', ['a@b.ch']]
    ] as const) {
      const result = await call(h, CREATE, { ...OFFER_INPUT, [field]: value })
      expect(result.body.error).toBe(
        `"${field}" is personal data. Writing it needs COLADA_ALLOW_PERSONAL_DATA=true. Nothing was written.`
      )
    }
    expect(rtdbRequests(world)).toEqual([])
  })

  it('refuses identity fields, an unknown currency and archived as input (E29, AC-P8)', async () => {
    const { h, world } = await setup()
    for (const field of ['owner', 'number', 'createdAt', 'uid']) {
      const refused = await schemaText(h, CREATE, { ...OFFER_INPUT, [field]: 'x' })
      expect(refused.isError).toBe(true)
      expect(refused.text).toContain(`"${field}" cannot be set. The MCP sets it from your login.`)
    }
    expect((await schemaText(h, CREATE, { ...OFFER_INPUT, archived: true })).text).toContain(
      '"archived" is not an input of this tool.'
    )
    expect((await schemaText(h, CREATE, { ...OFFER_INPUT, currency: 'GBP' })).isError).toBe(true)
    expect(rtdbRequests(world)).toEqual([])
  })

  it('writes the personal fields with the flag and shows them in the output', async () => {
    const { h, fw } = await setup({ allowPersonalData: true })
    const result = await call(h, CREATE, {
      ...OFFER_INPUT,
      person: 'k3',
      notes: 'call back',
      participants: ['a@b.ch'],
      projectManager: 'pm@b.ch',
      currency: 'EUR',
      eventsNum: 2,
      guests: 40,
      location: 'L2',
      rooms: ['R7']
    })
    const id = result.body.id as string

    expect(node(fw, 'planner')[id]).toMatchObject({
      person: 'k3',
      notes: 'call back',
      participants: ['a@b.ch'],
      projectManager: 'pm@b.ch',
      currency: 'EUR',
      eventsNum: 2,
      guests: 40,
      location: 'L2',
      rooms: ['R7']
    })
    expect(result.body.offer).toMatchObject({ person: 'k3', notes: 'call back' })
  })

  it('logs one line per write: the counter PUT and the root PATCH with its keys, no values or token (AC-P11)', async () => {
    const { h } = await setup({ allowPersonalData: true })
    const result = await call(h, CREATE, { ...OFFER_INPUT, notes: 'secret words' })
    const id = result.body.id as string

    const lines = h.logs.filter((line) => line.tool === CREATE) as unknown as Array<Record<string, unknown>>
    expect(lines.map((line) => [line.method, line.path, line.ifMatch, line.httpStatus])).toEqual([
      ['PUT', 'projectCounter', true, 200],
      ['PATCH', '/', false, 200]
    ])
    expect(lines[1]?.paths).toEqual([
      `planner/${id}`,
      `plannerBudgets/${id}`,
      `taskBoards/${id}`,
      `/externalIds/${result.body.externalId}`
    ])
    const text = JSON.stringify(lines)
    expect(text).not.toContain('secret words')
    expect(text).not.toContain('Spring Fair')
    expect(text).not.toContain('eyJ')
  })
})

describe('campaigns_update_offer', () => {
  it('changes only the given fields with deep keys, and syncs name / status to the lead (P18, P23)', async () => {
    const { h, fw, world } = await setup()
    const result = await call(h, UPDATE, { offer: 'o1', name: 'Gala 2027', status: 'offered', po: 'PO-1' })

    expect(result.isError).toBe(false)
    expect(node(fw, 'planner').o1).toEqual({
      ...O1,
      name: 'Gala 2027',
      status: 'offered',
      po: 'PO-1',
      updatedAt: NOW_JSON,
      updatedBy: ME
    })
    expect(node(fw, 'deals').o1).toEqual({
      uid: 'o1',
      name: 'Gala 2027',
      status: 'offered',
      owner: 'boss',
      costCenter: 'cc1',
      updatedAt: NOW_JSON,
      updatedBy: ME
    })
    const p = `workspaces/${WS}/planner/o1`
    const d = `workspaces/${WS}/deals/o1`
    expect(writeSummary(world)).toEqual([
      `PATCH /.json ${p}/name ${p}/status ${p}/po ${p}/updatedAt ${p}/updatedBy ${d}/name ${d}/status ${d}/updatedAt ${d}/updatedBy`
    ])
    expect(result.body).toMatchObject({
      offer: 'o1',
      changed: ['name', 'status', 'po'],
      deal: { synced: ['name', 'status'] },
      written: [{ method: 'PATCH', path: '/' }]
    })
  })

  it('touches no deal when the call has no name or status, or the offer has no lead', async () => {
    const { h, fw, world } = await setup()
    await call(h, UPDATE, { offer: 'o1', guests: 50 })
    const noDeal = await call(h, UPDATE, { offer: 'o4', name: 'Solo' })

    expect(noDeal.body.deal).toBeNull()
    expect(node(fw, 'deals').o1?.name).toBe('Gala')
    expect(writes(world).every((request) => !String(request.body).includes('/deals/'))).toBe(true)
  })

  it('a client change clears person, a location change clears rooms, as the form does', async () => {
    const { h, fw } = await setup()
    const result = await call(h, UPDATE, { offer: 'o1', client: 'c5', location: 'L5' })

    expect(node(fw, 'planner').o1).toMatchObject({ client: 'c5', person: '', location: 'L5', rooms: '' })
    expect(result.body.changed).toEqual(['client', 'location', 'person', 'rooms'])
  })

  it('keeps person and rooms given in the same call, and leaves them when client / location do not change', async () => {
    const { h, fw } = await setup({ allowPersonalData: true })
    await call(h, UPDATE, { offer: 'o1', client: 'c5', person: 'k5', location: 'L5', rooms: ['R5'] })
    expect(node(fw, 'planner').o1).toMatchObject({ person: 'k5', rooms: ['R5'] })

    await call(h, UPDATE, { offer: 'o1', client: 'c5', location: 'L5' })
    expect(node(fw, 'planner').o1).toMatchObject({ person: 'k5', rooms: ['R5'] })
  })

  it('checks a date pair against the stored partner only when the call touches it (P19)', async () => {
    const { h, world } = await setup()
    expect((await call(h, UPDATE, { offer: 'o1', endDate: '2027-02-28T10:00' })).body.error).toBe(
      'startDate is after endDate.'
    )
    expect((await call(h, UPDATE, { offer: 'o4', endDate: '2027-03-01T12:00' })).isError).toBe(false)
    expect((await call(h, UPDATE, { offer: 'o1', startDate: '2027-03-01' })).body.error).toBe(
      'startDate must be yyyy-MM-ddTHH:mm.'
    )
    expect(writes(world)).toHaveLength(1)
  })

  it('refuses an archived (E26), hidden (E18) or missing (E21) offer before any write', async () => {
    const { h, world } = await setup()
    expect((await call(h, UPDATE, { offer: 'o2', name: 'X' })).body.error).toBe(
      'Offer o2 is archived and cannot be changed.'
    )
    expect((await call(h, UPDATE, { offer: 'o3', name: 'X' })).body.error).toBe(
      'Offer o3 is not found or is hidden from you. Nothing was written.'
    )
    expect((await call(h, UPDATE, { offer: 'o9', name: 'X' })).body.error).toBe(
      `Offer "o9" does not exist in workspace ${WS}. Nothing was written.`
    )
    expect((await call(h, UPDATE, { offer: 'o1', costCenter: 'cc7' })).body.error).toBe(
      `Cost center "cc7" does not exist in workspace ${WS}. Nothing was written.`
    )
    expect(writes(world)).toEqual([])
  })

  it('refuses fields outside the allowlist and a call with no field (P23, X10)', async () => {
    const { h, world } = await setup()
    for (const field of ['prefix', 'total', 'archived', 'externalId', 'lead', 'list']) {
      expect((await schemaText(h, UPDATE, { offer: 'o1', [field]: 'x' })).text).toContain(
        `"${field}" is not an input of this tool.`
      )
    }
    expect((await schemaText(h, UPDATE, { offer: 'o1', owner: ME })).text).toContain('"owner" cannot be set.')
    expect((await call(h, UPDATE, { offer: 'o1' })).body.error).toBe('Pass at least one field to change besides offer.')
    expect(rtdbRequests(world)).toEqual([])
  })

  it('refuses without offers/settings:manage (E17) and personal fields without the flag (E20)', async () => {
    const { h, world } = await setup({ permissions: ['campaigns_app:view', 'campaigns_app/offers:manage'] })
    expect((await call(h, UPDATE, { offer: 'o1', name: 'X' })).body.error).toBe(
      `You lack campaigns_app/offers/settings:manage in workspace ${WS}, so ${UPDATE} cannot write.`
    )
    expect((await call(h, UPDATE, { offer: 'o1', notes: 'x' })).body.error).toContain('"notes" is personal data')
    expect(rtdbRequests(world)).toEqual([])
  })
})

describe('campaigns_create_lead', () => {
  it('needs the flag, because name is personal (P33, E20)', async () => {
    const { h, world } = await setup()
    expect((await call(h, LEAD, { name: 'New lead' })).body.error).toBe(
      '"name" is personal data. Writing it needs COLADA_ALLOW_PERSONAL_DATA=true. Nothing was written.'
    )
    expect(rtdbRequests(world)).toEqual([])
  })

  it('creates a lead as usePipeline.create: one root PATCH of deal, scaffold and externalIds (P18, P30)', async () => {
    const { h, fw, world } = await setup({ allowPersonalData: true })
    const result = await call(h, LEAD, {
      name: 'Autumn Expo',
      client: 'c3',
      contact: 'k3',
      summary: 'big hall',
      closeDate: '2027-04-01T00:00:00.000Z'
    })

    expect(result.isError).toBe(false)
    const id = result.body.id as string
    const externalId = result.body.externalId as string
    expect(id).toMatch(KEY)
    expect(node(fw, 'deals')[id]).toEqual({
      name: 'Autumn Expo',
      client: 'c3',
      contact: 'k3',
      summary: 'big hall',
      closeDate: '2027-04-01T00:00:00.000Z',
      status: 'qualified',
      chance: '25%',
      owner: ME,
      updatedBy: ME,
      updatedAt: NOW_JSON,
      createdAt: NOW_JSON,
      archived: false,
      externalId,
      uid: id
    })
    expect(node(fw, 'taskBoards')[id]).toEqual({
      uid: id,
      prefix: 'AE',
      boards: [{ id: 'backlog' }, { id: 'progress' }, { id: 'finished', final: true }, { id: 'archived' }],
      taskCounter: 0
    })
    expect(fw.externalIds[externalId]).toEqual({ source: id, workspace: WS })
    expect(writeSummary(world)).toEqual([
      `PATCH /.json workspaces/${WS}/deals/${id} workspaces/${WS}/taskBoards/${id} externalIds/${externalId}`
    ])
    expect(fw.rtdb[WS]?.projectCounter).toBe(41)
    expect(result.body).toMatchObject({ written: [{ method: 'PATCH', path: '/' }] })
  })

  it('refuses accountManager, costCenter, plannerProject and offer as input (P9, P18, P34)', async () => {
    const { h, world } = await setup({ allowPersonalData: true })
    expect((await schemaText(h, LEAD, { name: 'L', accountManager: ME })).text).toContain(
      '"accountManager" cannot be set.'
    )
    for (const field of ['costCenter', 'plannerProject', 'offer']) {
      expect((await schemaText(h, LEAD, { name: 'L', [field]: 'x' })).text).toContain(
        `"${field}" is not an input of this tool.`
      )
    }
    expect((await schemaText(h, LEAD, { name: 'L', chance: '30%' })).isError).toBe(true)
    expect(rtdbRequests(world)).toEqual([])
  })

  it('refuses without leads:manage (E17) with no RTDB request', async () => {
    const { h, world } = await setup({ allowPersonalData: true, permissions: ['campaigns_app:view'] })
    expect((await call(h, LEAD, { name: 'L' })).body.error).toBe(
      `You lack campaigns_app/leads:manage in workspace ${WS}, so ${LEAD} cannot write.`
    )
    expect(rtdbRequests(world)).toEqual([])
  })
})

describe('offer and lead tools never write projects/ or deals/*/costCenter (AC-P8)', () => {
  it('leaves projects and the lead costCenter as they were after every tool ran', async () => {
    const { h, fw, world } = await setup({ allowPersonalData: true })
    const projects = structuredClone(fw.rtdb[WS]?.projects)
    await call(h, CREATE, { ...OFFER_INPUT, costCenter: 'cc1' })
    await call(h, CREATE, { lead: 'd2', startDate: '2027-06-01T09:00', endDate: '2027-06-01T18:00' })
    await call(h, UPDATE, { offer: 'o1', name: 'N', status: 'offered', costCenter: 'cc2' })
    await call(h, LEAD, { name: 'L' })

    expect(fw.rtdb[WS]?.projects).toEqual(projects)
    expect(node(fw, 'deals').o1?.costCenter).toBe('cc1')
    const bodies = writes(world).map((request) => `${request.url.pathname} ${String(request.body)}`)
    expect(bodies.some((text) => text.includes('/projects/'))).toBe(false)
    expect(bodies.some((text) => /deals\/[^"]+\/costCenter/.test(text))).toBe(false)
    expect(writes(world).some((request) => request.method === 'DELETE')).toBe(false)
  })
})
