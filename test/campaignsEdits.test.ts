import { afterEach, describe, expect, it } from 'vitest'
import { type BudgetRow, calculateAllocated, calculateTotal } from '../src/firebase/campaigns/budgetMath.js'
import { firebaseSetup, ME, rtdbRequests } from './firebaseFake.js'
import { fakeUser, type Harness, WS_A } from './harness.js'

const WS = WS_A
const UPDATE_ROW = 'campaigns_update_budget_row'
const REMOVE_ROWS = 'campaigns_remove_budget_rows'
const ADD_ROWS = 'campaigns_add_budget_rows'
const UPDATE_LEAD = 'campaigns_update_lead'
const KB_SEARCH = 'campaigns_kb_search'
const RATES = { EUR: 1.05 }
const NOW_JSON = '2027-01-15T08:00:00.000Z'

type Row = { uid: string; name?: string; content?: Record<string, unknown>; subRows?: Row[] }

const BUDGET: Row[] = [
  { uid: 'r1', name: 'Venue', content: { price: 1000, selectedQuantity: 1, allocated: 300 } },
  {
    uid: 'g1',
    name: 'Catering',
    content: { price: 0, selectedQuantity: 1 },
    subRows: [
      { uid: 'g1a', name: 'Food', content: { price: 20, selectedQuantity: 50, currency: 'EUR' } },
      { uid: 'g1b', name: 'Drinks', content: { price: 5, selectedQuantity: 50 } }
    ]
  },
  {
    uid: 'r3',
    name: 'Staff',
    content: { price: 40, selectedQuantity: 10, reports: { '2027-01-10': [{ uid: 't1' }, { uid: 't2' }] } }
  }
]

const KB = [
  {
    uid: 'kb1',
    name: 'Technik',
    children: [
      {
        uid: 'kb2',
        name: 'Audio',
        children: [
          {
            uid: 'kb3',
            name: 'Funkmikrofon Shure',
            content: { price: { CHF: '120', EUR: '110' }, quantityType: 'Stk.' }
          },
          { uid: 'kb4', name: 'Kabel', content: { pdfDescription: 'XLR für Mikrofon', price: { CHF: '5' } } }
        ]
      }
    ]
  },
  { uid: 'kb5', name: 'Mikrofonständer', content: { price: { CHF: '15' } } }
]

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

async function setup(options: { allowPersonalData?: boolean; permissions?: string[] } = {}) {
  const result = await firebaseSetup({ allowPersonalData: options.allowPersonalData ?? true })
  harnesses.push(result.h)
  result.fw.permissions = options.permissions ?? [
    'campaigns_app:view',
    'campaigns_app/offers/budget:manage',
    'campaigns_app/leads:manage',
    'campaigns_app/knowledgeBase:view'
  ]
  result.fw.world.users.set(WS, [fakeUser(ME, 'frank@colada.test'), fakeUser('u-am', 'am@b.ch')])
  result.fw.rtdb[WS] = {
    planner: {
      o1: { uid: 'o1', name: 'Gala', status: 'qualified', currency: 'CHF', exchangeRates: RATES, owner: 'boss' },
      o2: { uid: 'o2', name: 'New', currency: 'CHF', owner: 'boss' },
      d1: { uid: 'd1', name: 'Lead with offer', status: 'qualified', owner: 'boss' }
    },
    plannerBudgets: {
      o1: structuredClone(BUDGET),
      o2: [{ uid: 'blank', name: '', content: { price: 0, selectedQuantity: 1 } }]
    },
    deals: {
      d1: { uid: 'd1', name: 'Lead with offer', status: 'qualified', owner: 'boss', costCenter: 'cc1' },
      d2: { uid: 'd2', name: 'Lead only', status: 'qualified', owner: 'boss', chance: '25%' },
      d3: { uid: 'd3', name: 'Old', owner: 'boss', archived: true }
    },
    knowledgeBase: KB,
    projects: { p1: { uid: 'p1', name: 'Fair' } }
  }
  return result
}

type Fw = Awaited<ReturnType<typeof setup>>['fw']
type World = Awaited<ReturnType<typeof setup>>['world']

const node = <T>(fw: Fw, name: string) => fw.rtdb[WS]?.[name] as Record<string, T>
const budget = (fw: Fw, offer = 'o1') => node<Row[]>(fw, 'plannerBudgets')[offer] as Row[]
const planner = (fw: Fw, id = 'o1') => node<Record<string, unknown>>(fw, 'planner')[id]
const deal = (fw: Fw, id: string) => node<Record<string, unknown>>(fw, 'deals')[id]
const history = (fw: Fw) =>
  Object.values((fw.rtdb[WS]?.history ?? {}) as Record<string, Record<string, unknown>>).map((record) => [
    record.action,
    record.item,
    record.field,
    record.from,
    record.to
  ])
const writes = (world: World) => rtdbRequests(world).filter((request) => request.method !== 'GET')
const writeSummary = (world: World) =>
  writes(world).map((request) => {
    const path = request.url.pathname.replace(`/workspaces/${WS}/`, '')
    if (request.method !== 'PATCH') return `${request.method} ${path}`
    const keys = Object.keys(JSON.parse(String(request.body))).map((key) =>
      key.replace(`workspaces/${WS}/`, '').replace(/^history\/[-0-9A-Za-z_]{20}$/, 'history/<key>')
    )
    return `PATCH ${path} ${keys.join(' ')}`
  })

const call = (h: Harness, tool: string, args: Record<string, unknown>) => h.call(tool, { workspace: WS, ...args })

function expectTotals(fw: Fw, offer = 'o1') {
  const rows = budget(fw, offer) as unknown as BudgetRow[]
  expect(planner(fw, offer)).toMatchObject({
    total: calculateTotal(rows, false, 'CHF', offer === 'o1' ? RATES : null),
    allocated: calculateAllocated(rows)
  })
}

describe('campaigns_update_budget_row (AC-6.8)', () => {
  it('a pdfDescription change is reported in changed, with no history record like the app', async () => {
    const { h, fw } = await setup()
    const result = await call(h, UPDATE_ROW, { offer: 'o1', row: 'r1', pdfDescription: 'New text' })
    expect(result.isError).toBe(false)
    expect(result.body.changed).toEqual(['pdfDescription'])
    expect(result.body.unchanged).toBeUndefined()
    expect(budget(fw)[0]?.content).toMatchObject({ pdfDescription: 'New text' })
    expect(history(fw)).toEqual([])
  })

  it('edits fields like the budget table: one "updated" record per changed field, then total and allocated', async () => {
    const { h, fw, world } = await setup()
    const result = await call(h, UPDATE_ROW, { offer: 'o1', row: 'g1a', name: 'Dinner', price: 25, q1: 60 })

    expect(result.isError).toBe(false)
    expect(budget(fw)[1]?.subRows?.[0]).toEqual({
      uid: 'g1a',
      name: 'Dinner',
      content: { price: 25, selectedQuantity: 60, currency: 'EUR' }
    })
    expect(budget(fw)[0]).toEqual(BUDGET[0])
    expect(history(fw)).toEqual([
      ['updated', 'Food', 'name', 'Food', 'Dinner'],
      ['updated', 'Dinner', 'price', 20, 25],
      ['updated', 'Dinner', 'selectedQuantity', 50, 60]
    ])
    expectTotals(fw)
    expect(writeSummary(world)).toEqual([
      'PUT plannerBudgets/o1.json',
      'PATCH /.json planner/o1/total planner/o1/allocated history/<key> history/<key> history/<key>'
    ])
    expect(result.body).toMatchObject({
      offer: 'o1',
      row: { uid: 'g1a', name: 'Dinner', parentRow: 'g1', position: 0 },
      changed: ['name', 'price', 'selectedQuantity']
    })
  })

  it('moves a sub-row to the top level without history, as the app does', async () => {
    const { h, fw } = await setup()
    const result = await call(h, UPDATE_ROW, { offer: 'o1', row: 'g1b', parentRow: '', position: 0 })

    expect(result.isError).toBe(false)
    expect(budget(fw).map((row) => row.uid)).toEqual(['g1b', 'r1', 'g1', 'r3'])
    expect(budget(fw)[2]?.subRows?.map((row) => row.uid)).toEqual(['g1a'])
    expect(history(fw)).toEqual([])
    expectTotals(fw)
    expect(result.body.row).toMatchObject({ parentRow: null, position: 0 })
  })

  it('moves a row into a group at a position', async () => {
    const { h, fw } = await setup()
    await call(h, UPDATE_ROW, { offer: 'o1', row: 'r1', parentRow: 'g1', position: 1 })
    expect(budget(fw).map((row) => row.uid)).toEqual(['g1', 'r3'])
    expect(budget(fw)[0]?.subRows?.map((row) => row.uid)).toEqual(['g1a', 'r1', 'g1b'])
  })

  it.each([
    [{ row: 'nope', name: 'X' }, 'Row "nope" is not in the budget of offer o1'],
    [{ row: 'g1', parentRow: 'g1a' }, 'cannot be moved into itself or its own sub-rows'],
    [{ row: 'r1', parentRow: 'nope' }, 'parentRow "nope" is not in the budget of offer o1'],
    [{ row: 'r1', position: 9 }, 'position 9 is outside 0..2'],
    [{ row: 'r1' }, 'Pass at least one field to change besides offer and row']
  ])('refuses %o and writes nothing', async (args, message) => {
    const { h, world } = await setup()
    const result = await call(h, UPDATE_ROW, { offer: 'o1', ...args })
    expect(result.isError).toBe(true)
    expect(result.body.error).toContain(message)
    expect(writes(world)).toEqual([])
  })

  it('a change to the same values writes nothing', async () => {
    const { h, world } = await setup()
    const result = await call(h, UPDATE_ROW, { offer: 'o1', row: 'r1', name: 'Venue', price: 1000 })
    expect(result.body).toMatchObject({ unchanged: true, changed: [] })
    expect(writes(world)).toEqual([])
  })

  it('keeps a concurrent change on 412 and writes the history once (AC-P6)', async () => {
    const { h, fw } = await setup()
    let changed = false
    fw.beforeWrite = (method, path) => {
      if (changed || method !== 'PUT' || !path.endsWith('plannerBudgets/o1')) return
      changed = true
      budget(fw)[0] = { ...(budget(fw)[0] as Row), name: 'Venue (renamed)' }
    }
    const result = await call(h, UPDATE_ROW, { offer: 'o1', row: 'g1a', price: 30 })

    expect(result.body.retries).toBe(1)
    expect(budget(fw)[0]?.name).toBe('Venue (renamed)')
    expect(budget(fw)[1]?.subRows?.[0]?.content?.price).toBe(30)
    expect(history(fw)).toEqual([['updated', 'Food', 'price', 20, 30]])
    expectTotals(fw)
  })
})

describe('campaigns_remove_budget_rows (AC-6.8, Q22, Q23)', () => {
  it('removes a row with one "itemRemoved" record, then total and allocated', async () => {
    const { h, fw, world } = await setup()
    const result = await call(h, REMOVE_ROWS, { offer: 'o1', rows: ['r1', 'g1b'] })

    expect(result.isError).toBe(false)
    expect(budget(fw).map((row) => row.uid)).toEqual(['g1', 'r3'])
    expect(budget(fw)[0]?.subRows?.map((row) => row.uid)).toEqual(['g1a'])
    expect(history(fw)).toEqual([
      ['itemRemoved', 'Venue', '', '', ''],
      ['itemRemoved', 'Drinks', '', '', '']
    ])
    expectTotals(fw)
    expect(writeSummary(world)).toEqual([
      'PUT plannerBudgets/o1.json',
      'PATCH /.json planner/o1/total planner/o1/allocated history/<key> history/<key>'
    ])
    expect(result.body.removed).toEqual([
      { uid: 'r1', name: 'Venue', subRows: 0 },
      { uid: 'g1b', name: 'Drinks', subRows: 0 }
    ])
  })

  it('removes a group only with withSubRows', async () => {
    const { h, fw, world } = await setup()
    const refused = await call(h, REMOVE_ROWS, { offer: 'o1', rows: ['g1'] })
    expect(refused.body.error).toContain('Row "g1" has sub-rows. Pass withSubRows: true')
    expect(writes(world)).toEqual([])

    const result = await call(h, REMOVE_ROWS, { offer: 'o1', rows: ['g1'], withSubRows: true })
    expect(result.isError).toBe(false)
    expect(budget(fw).map((row) => row.uid)).toEqual(['r1', 'r3'])
    expect(history(fw)).toEqual([['itemRemoved', 'Catering', '', '', '']])
  })

  it('a group and its own sub-row in one call: the group removes both', async () => {
    const { h, fw } = await setup()
    const result = await call(h, REMOVE_ROWS, { offer: 'o1', rows: ['g1', 'g1a'], withSubRows: true })
    expect(result.isError).toBe(false)
    expect(budget(fw).map((row) => row.uid)).toEqual(['r1', 'r3'])
    expect(history(fw)).toEqual([['itemRemoved', 'Catering', '', '', '']])
  })

  it('refuses a row with timesheet copies, naming the row and the count (Q22)', async () => {
    const { h, world } = await setup()
    const result = await call(h, REMOVE_ROWS, { offer: 'o1', rows: ['r1', 'r3'] })
    expect(result.isError).toBe(true)
    expect(result.body.error).toContain('Row "r3" (Staff) or its sub-rows have 2 timesheet copies')
    expect(writes(world)).toEqual([])
  })

  it('refuses a group whose sub-row has timesheet copies', async () => {
    const { h, fw, world } = await setup()
    const rows = budget(fw)
    ;(rows[1]?.subRows?.[0]?.content as Record<string, unknown>).reports = { '2027-01-11': [{ uid: 't9' }] }
    const result = await call(h, REMOVE_ROWS, { offer: 'o1', rows: ['g1'], withSubRows: true })
    expect(result.body.error).toContain('Row "g1" (Catering) or its sub-rows have 1 timesheet copies')
    expect(writes(world)).toEqual([])
  })

  it('refuses to remove the last row (X6 stays)', async () => {
    const { h, world } = await setup()
    const result = await call(h, REMOVE_ROWS, { offer: 'o2', rows: ['blank'] })
    expect(result.isError).toBe(true)
    expect(result.body.error).toContain('would have no rows left')
    expect(writes(world)).toEqual([])
  })

  it('refuses an unknown row', async () => {
    const { h, world } = await setup()
    const result = await call(h, REMOVE_ROWS, { offer: 'o1', rows: ['nope'] })
    expect(result.body.error).toContain('Row "nope" is not in the budget of offer o1')
    expect(writes(world)).toEqual([])
  })

  it('keeps a row another user added between read and write (AC-P6)', async () => {
    const { h, fw } = await setup()
    let changed = false
    fw.beforeWrite = (method, path) => {
      if (changed || method !== 'PUT' || !path.endsWith('plannerBudgets/o1')) return
      changed = true
      budget(fw).push({ uid: 'x9', name: 'Other user row', content: { price: 1, selectedQuantity: 1 } })
    }
    const result = await call(h, REMOVE_ROWS, { offer: 'o1', rows: ['r1'] })
    expect(result.body.retries).toBe(1)
    expect(budget(fw).map((row) => row.uid)).toEqual(['g1', 'r3', 'x9'])
    expect(history(fw)).toEqual([['itemRemoved', 'Venue', '', '', '']])
    expectTotals(fw)
  })
})

describe('campaigns_add_budget_rows replaceBlankRow (Q23)', () => {
  it('on a new offer leaves only the added rows', async () => {
    const { h, fw, world } = await setup()
    const result = await call(h, ADD_ROWS, {
      offer: 'o2',
      replaceBlankRow: true,
      rows: [
        { type: 'free', name: 'Room', price: 100 },
        { type: 'free', name: 'Tech', price: 50 }
      ]
    })
    expect(result.isError).toBe(false)
    expect(budget(fw, 'o2').map((row) => row.name)).toEqual(['Room', 'Tech'])
    expect(result.body.replacedBlankRow).toBe('blank')
    expect((result.body.rows as Array<{ position: number }>).map((row) => row.position)).toEqual([0, 1])
    expectTotals(fw, 'o2')
    expect(writeSummary(world)[0]).toBe('PUT plannerBudgets/o2.json')
  })

  it('is refused when the budget has no blank row', async () => {
    const { h, world } = await setup()
    const result = await call(h, ADD_ROWS, {
      offer: 'o1',
      replaceBlankRow: true,
      rows: [{ type: 'free', name: 'Room' }]
    })
    expect(result.body.error).toContain('replaceBlankRow: the budget of offer o1 has no blank row')
    expect(writes(world)).toEqual([])
  })
})

describe('campaigns_update_lead (AC-6.7, Q12, Q25)', () => {
  it('writes only the given fields and the audit fields; name and status go to the offer', async () => {
    const { h, fw, world } = await setup()
    const result = await call(h, UPDATE_LEAD, {
      lead: 'd1',
      name: 'Renamed',
      status: 'offered',
      summary: 'Call back',
      closeDate: '2027-04-01T00:00:00.000Z'
    })

    expect(result.isError).toBe(false)
    expect(writeSummary(world)).toEqual([
      'PATCH /.json deals/d1/name deals/d1/summary deals/d1/closeDate deals/d1/status deals/d1/updatedAt deals/d1/updatedBy planner/d1/name planner/d1/status'
    ])
    expect(deal(fw, 'd1')).toEqual({
      uid: 'd1',
      name: 'Renamed',
      status: 'offered',
      summary: 'Call back',
      closeDate: '2027-04-01T00:00:00.000Z',
      owner: 'boss',
      costCenter: 'cc1',
      updatedAt: NOW_JSON,
      updatedBy: ME
    })
    expect(planner(fw, 'd1')).toMatchObject({ name: 'Renamed', status: 'offered' })
    expect(result.body).toMatchObject({
      lead: 'd1',
      changed: ['name', 'summary', 'closeDate', 'status'],
      offer: { exists: true, synced: ['name', 'status'] }
    })
  })

  it('a lead with an offer and no synced field: the offer is reported, only deals is written', async () => {
    const { h, world } = await setup()
    const result = await call(h, UPDATE_LEAD, { lead: 'd1', chance: '75%' })
    expect(result.body.offer).toEqual({ exists: true, synced: [] })
    expect(writeSummary(world)).toEqual(['PATCH /.json deals/d1/chance deals/d1/updatedAt deals/d1/updatedBy'])
  })

  it('a lead without an offer: only deals is written', async () => {
    const { h, fw, world } = await setup()
    const result = await call(h, UPDATE_LEAD, { lead: 'd2', chance: '75%', client: 'c7', status: 'offered' })
    expect(result.body.offer).toEqual({ exists: false, synced: [] })
    expect(writeSummary(world)).toEqual([
      'PATCH /.json deals/d2/client deals/d2/status deals/d2/chance deals/d2/updatedAt deals/d2/updatedBy'
    ])
    expect(deal(fw, 'd2')).toMatchObject({ chance: '75%', client: 'c7' })
  })

  it('accountManager by email is stored as the uid; a non-Campaigns user is refused', async () => {
    const { h, fw, world } = await setup()
    const result = await call(h, UPDATE_LEAD, { lead: 'd2', accountManager: 'AM@b.ch' })
    expect(result.isError).toBe(false)
    expect(deal(fw, 'd2')?.accountManager).toBe('u-am')

    const before = writes(world).length
    const refused = await call(h, UPDATE_LEAD, { lead: 'd2', accountManager: 'stranger@b.ch' })
    expect(refused.body.error).toContain('no Campaigns user')
    expect(writes(world)).toHaveLength(before)
  })

  it.each([
    [{ lead: 'd3', name: 'X' }, 'Lead d3 is archived'],
    [{ lead: 'nope', name: 'X' }, 'nope'],
    [{ lead: 'd2' }, 'Pass at least one field to change besides lead']
  ])('refuses %o and writes nothing', async (args, message) => {
    const { h, world } = await setup()
    const result = await call(h, UPDATE_LEAD, args)
    expect(result.isError).toBe(true)
    expect(result.body.error).toContain(message)
    expect(writes(world)).toEqual([])
  })

  it('name, contact and summary need personal data on', async () => {
    const { h, world } = await setup({ allowPersonalData: false })
    for (const field of ['name', 'contact', 'summary']) {
      const result = await call(h, UPDATE_LEAD, { lead: 'd2', [field]: 'x' })
      expect(result.isError).toBe(true)
    }
    const allowed = await call(h, UPDATE_LEAD, { lead: 'd2', status: 'offered' })
    expect(allowed.isError).toBe(false)
    expect(writes(world)).toHaveLength(1)
  })

  it('costCenter is not an input', async () => {
    const { h } = await setup()
    const result = await h.client.callTool({
      name: UPDATE_LEAD,
      arguments: { workspace: WS, lead: 'd2', costCenter: 'cc1' }
    })
    expect(result.isError).toBe(true)
  })
})

describe('new write tools never touch projects/, deals/*/costCenter or delete a node (AC-P8)', () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    [UPDATE_ROW, { offer: 'o1', row: 'g1a', name: 'Dinner', price: 25 }],
    [UPDATE_ROW, { offer: 'o1', row: 'r1', parentRow: 'g1' }],
    [REMOVE_ROWS, { offer: 'o1', rows: ['r1', 'g1'], withSubRows: true }],
    [ADD_ROWS, { offer: 'o2', replaceBlankRow: true, rows: [{ type: 'free', name: 'Room' }] }],
    [UPDATE_LEAD, { lead: 'd1', name: 'N', status: 'offered', client: 'c1', accountManager: ME }]
  ]
  it.each(calls)('%s %o', async (tool, args) => {
    const { h, world } = await setup()
    const result = await call(h, tool, args)
    expect(result.isError).toBe(false)
    const sent = writes(world)
    expect(sent.length).toBeGreaterThan(0)
    for (const request of sent) {
      expect(['PUT', 'PATCH']).toContain(request.method)
      const text = `${request.url.pathname} ${String(request.body)}`
      expect(text).not.toMatch(/\/projects\/|"projects\/|costCenter/)
      expect(String(request.body)).not.toBe('null')
    }
  })
})

describe('campaigns_kb_search (AC-6.10, Q15)', () => {
  it('finds an item 3 levels deep by part of its name in any case', async () => {
    const { h } = await setup()
    const result = await call(h, KB_SEARCH, { query: 'SHURE' })
    expect(result.isError).toBe(false)
    expect(result.body.matches).toBe(1)
    expect(result.body.items).toEqual([
      {
        uid: 'kb3',
        name: 'Funkmikrofon Shure',
        path: ['Technik', 'Audio'],
        unit: 'Stk.',
        price: { CHF: '120', EUR: '110' }
      }
    ])
  })

  it('matches the PDF description too, and limit cuts the list but not the count', async () => {
    const { h } = await setup()
    const all = await call(h, KB_SEARCH, { query: 'mikrofon' })
    expect((all.body.items as Array<{ uid: string }>).map((item) => item.uid)).toEqual(['kb3', 'kb4', 'kb5'])
    const one = await call(h, KB_SEARCH, { query: 'mikrofon', limit: 1 })
    expect(one.body).toMatchObject({ matches: 3, items: [{ uid: 'kb3' }] })
  })

  it('needs campaigns_app/knowledgeBase:view', async () => {
    const { h } = await setup({ permissions: ['campaigns_app:view'] })
    const result = await call(h, KB_SEARCH, { query: 'audio' })
    expect(result.isError).toBe(true)
    expect(result.body.error).toContain('campaigns_app/knowledgeBase:view')
  })
})
