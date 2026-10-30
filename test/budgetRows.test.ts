import { afterEach, describe, expect, it } from 'vitest'
import { type BudgetRow, calculateAllocated, calculateTotal } from '../src/firebase/campaigns/budgetMath.js'
import { firebaseSetup, ME, rtdbRequests } from './firebaseFake.js'
import { type Harness, WS_A } from './harness.js'

const WS = WS_A
const ADD = 'campaigns_add_budget_rows'
const ALL = ['campaigns_app:view', 'campaigns_app/offers/budget:manage']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RATES = { EUR: 1.05 }
const NOW_JSON = '2027-01-15T08:00:00.000Z'
const PUSH_KEY = /^[-0-9A-Za-z_]{20}$/

const OFFER = {
  uid: 'o1',
  name: 'Gala',
  currency: 'CHF',
  exchangeRates: RATES,
  owner: 'boss',
  archived: false,
  total: 2000,
  allocated: 0
}

const BUDGET = [
  { uid: 'r1', name: 'Venue', content: { price: 1000, selectedQuantity: 1, allocated: 300 } },
  {
    uid: 'g1',
    name: 'Catering',
    content: { price: 0, selectedQuantity: 1 },
    subRows: [{ uid: 'g1a', name: 'Food', content: { price: 20, selectedQuantity: 50, currency: 'EUR' } }]
  }
]

const KB_AUDIO = {
  uid: 'kbA',
  name: 'Audio',
  root: true,
  selected: true,
  number: 'A-001',
  content: {
    price: { CHF: '100', EUR: '90' },
    offset: { CHF: '5' },
    internal: true,
    pdfDescription: 'pdf A',
    selectedQuantity: 0
  },
  children: [
    { uid: 'kbA1', name: 'Speaker', content: { price: { CHF: '50' }, quantityType: 'Stk.' } },
    { uid: 'kbA2', name: 'Cable' }
  ]
}
const KB_FEE = {
  uid: 'kbR',
  name: 'Agency fee',
  content: {
    effort: 'reserve',
    feeMode: 'nonlinear',
    baseMin: { CHF: '1000' },
    baseMax: { CHF: '10000' },
    rateAtMin: 10,
    rateAtMax: 5,
    selectedQuantity: 10,
    offset: { CHF: '50' }
  }
}
const KB_EURO = {
  uid: 'kbE',
  name: 'Euro only',
  content: { price: { EUR: '70' }, offset: { EUR: '3' }, baseMin: { EUR: '1' } }
}

const CONVERTED_DEFAULTS = {
  price: 0,
  offset: 0,
  pdfDescription: '',
  selectedQuantity: 1,
  quantityType: '',
  qty2: 0,
  quantity2Unit: '',
  shortDescription: '',
  effort: '',
  feeMode: 'linear',
  baseMin: 0,
  rateAtMin: 0,
  baseMax: 0,
  rateAtMax: 0
}

type Row = { uid: string; name?: string; ref?: string; content?: Record<string, unknown>; subRows?: Row[] }

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

async function setup(options: { permissions?: string[] } = {}) {
  const result = await firebaseSetup()
  harnesses.push(result.h)
  result.fw.permissions = options.permissions ?? ALL
  result.fw.rtdb[WS] = {
    planner: {
      o1: structuredClone(OFFER),
      o2: { ...OFFER, uid: 'o2', archived: true },
      o3: { ...OFFER, uid: 'o3', isPrivate: 'true' },
      o4: { ...OFFER, uid: 'o4' }
    },
    plannerBudgets: {
      o1: structuredClone(BUDGET),
      o2: structuredClone(BUDGET),
      o4: { 0: structuredClone(BUDGET[0]), 1: structuredClone(BUDGET[1]) }
    },
    knowledgeBase: [
      KB_AUDIO,
      KB_FEE,
      KB_EURO,
      { uid: 'kbG', name: 'Group', children: [{ uid: 'kbG1', name: 'Deep' }] },
      { uid: 'kbN', content: { price: { CHF: 4 } } }
    ],
    units: [
      { uid: 'Std.', name: 'Std.' },
      { uid: 'Stk.', name: 'Stk.' }
    ]
  }
  return result
}

type Fw = Awaited<ReturnType<typeof setup>>['fw']

const budget = (fw: Fw, offer = 'o1') =>
  (fw.rtdb[WS]?.plannerBudgets as Record<string, unknown> | undefined)?.[offer] as unknown as Row[]
const planner = (fw: Fw, offer = 'o1') =>
  (fw.rtdb[WS]?.planner as Record<string, Record<string, unknown>> | undefined)?.[offer] as Record<string, unknown>

const writeSummary = (world: Parameters<typeof rtdbRequests>[0]) =>
  rtdbRequests(world)
    .filter((request) => request.method !== 'GET')
    .map((request) => {
      const path = request.url.pathname.replace(`/workspaces/${WS}/`, '')
      if (request.method !== 'PATCH') return `${request.method} ${path}`
      const keys = Object.keys(JSON.parse(String(request.body))).map((key) =>
        key.replace(`workspaces/${WS}/`, '').replace(/^history\/[-0-9A-Za-z_]{20}$/, 'history/<key>')
      )
      return `PATCH ${path} ${keys.join(' ')}`
    })

type HistoryRecord = Record<string, unknown>
const history = (fw: Fw) => Object.values((fw.rtdb[WS]?.history ?? {}) as Record<string, HistoryRecord>)
const edits = (fw: Fw) => history(fw).map((record) => [record.item, record.field, record.from, record.to])

const add = (h: Harness, args: Record<string, unknown>) => h.call(ADD, { workspace: WS, offer: 'o1', ...args })

async function schemaText(h: Harness, args: Record<string, unknown>) {
  const result = await h.client.callTool({ name: ADD, arguments: { workspace: WS, offer: 'o1', ...args } })
  return { isError: result.isError === true, text: (result.content as Array<{ text: string }>)[0]?.text ?? '' }
}

function withoutUids(row: Row): unknown {
  const { uid: _uid, subRows, ...rest } = row
  return subRows ? { ...rest, subRows: subRows.map(withoutUids) } : rest
}

describe('campaigns_add_budget_rows: knowledge-base rows (AC-P3, P28)', () => {
  it('converts a KB node with children as convertKnowledgeBaseItemToBudgetItem does and appends it', async () => {
    const { h, fw } = await setup()
    const result = await add(h, { rows: [{ type: 'kb', kbItem: 'kbA' }] })

    expect(result.isError).toBe(false)
    const rows = budget(fw)
    expect(rows).toHaveLength(3)
    expect(rows.slice(0, 2)).toEqual(BUDGET)
    const added = rows[2] as Row
    expect(added.uid).toMatch(UUID)
    expect(added.subRows?.map((row) => row.uid)).toEqual([expect.stringMatching(UUID), expect.stringMatching(UUID)])
    expect(withoutUids(added)).toEqual({
      ref: 'kbA',
      name: 'Audio',
      number: 'A-001',
      content: {
        ...CONVERTED_DEFAULTS,
        price: 100,
        offset: 5,
        internal: true,
        pdfDescription: 'pdf A',
        service: 'internal'
      },
      subRows: [
        { ref: 'kbA1', name: 'Speaker', content: { ...CONVERTED_DEFAULTS, price: 50, quantityType: 'Stk.' } },
        { ref: 'kbA2', name: 'Cable', content: { price: 0, offset: 0, selectedQuantity: 1 } }
      ]
    })
  })

  it('converts a reserve (fee) row and a row with no price for the offer currency (0 fallback)', async () => {
    const { h, fw } = await setup()
    const result = await add(h, {
      rows: [
        { type: 'kb', kbItem: 'kbR' },
        { type: 'kb', kbItem: 'kbE' }
      ]
    })

    expect(result.isError).toBe(false)
    const [fee, euro] = budget(fw).slice(2) as [Row, Row]
    expect(withoutUids(fee)).toEqual({
      ref: 'kbR',
      name: 'Agency fee',
      content: {
        ...CONVERTED_DEFAULTS,
        effort: 'reserve',
        feeMode: 'nonlinear',
        baseMin: 1000,
        baseMax: 10000,
        rateAtMin: 10,
        rateAtMax: 5,
        selectedQuantity: 10,
        offset: 50
      }
    })
    expect(withoutUids(euro)).toEqual({ ref: 'kbE', name: 'Euro only', content: CONVERTED_DEFAULTS })
  })

  it('applies the overrides name, pdfDescription, price and q1/u1/q2/u2 (q1 0 becomes 1, as the app)', async () => {
    const { h, fw } = await setup()
    const result = await add(h, {
      rows: [
        {
          type: 'kb',
          kbItem: 'kbA1',
          name: 'Big speaker',
          pdfDescription: 'For the hall',
          price: 75,
          q1: 0,
          u1: 'Std.',
          q2: 3,
          u2: 'Stk.'
        }
      ]
    })

    expect(result.isError).toBe(false)
    expect(withoutUids(budget(fw)[2] as Row)).toEqual({
      ref: 'kbA1',
      name: 'Big speaker',
      content: {
        ...CONVERTED_DEFAULTS,
        price: 75,
        pdfDescription: 'For the hall',
        selectedQuantity: 1,
        quantityType: 'Std.',
        qty2: 3,
        quantity2Unit: 'Stk.'
      }
    })
  })

  it('does not change the knowledge base', async () => {
    const { h, fw } = await setup()
    const before = structuredClone(fw.rtdb[WS]?.knowledgeBase)
    await add(h, { rows: [{ type: 'kb', kbItem: 'kbA' }] })

    expect(fw.rtdb[WS]?.knowledgeBase).toEqual(before)
  })

  it('refuses a KB uid that is not in the tree (E21) with no write', async () => {
    const { h, world } = await setup()
    const result = await add(h, { rows: [{ type: 'kb', kbItem: 'nope' }] })

    expect(result.isError).toBe(true)
    expect(result.body.error).toBe(`Knowledge base item "nope" does not exist in workspace ${WS}. Nothing was written.`)
    expect(writeSummary(world)).toEqual([])
  })

  it('refuses a unit that is not in units (E21) with no write', async () => {
    const { h, world } = await setup()
    const result = await add(h, { rows: [{ type: 'free', name: 'Extra', u2: 'kg' }] })

    expect(result.isError).toBe(true)
    expect(result.body.error).toBe(`Unit "kg" does not exist in workspace ${WS}. Nothing was written.`)
    expect(writeSummary(world)).toEqual([])
  })
})

describe('campaigns_add_budget_rows: free rows, groups and placement (P15, P28, P30)', () => {
  it('writes a free row with uid and content, only the given fields besides price and quantity', async () => {
    const { h, fw } = await setup()
    const result = await add(h, { rows: [{ type: 'free', name: 'Transport', price: 250, q2: 2, u1: 'Stk.' }] })

    expect(result.isError).toBe(false)
    const row = budget(fw)[2] as Row
    expect(row.uid).toMatch(UUID)
    expect(withoutUids(row)).toEqual({
      name: 'Transport',
      content: { price: 250, selectedQuantity: 1, quantityType: 'Stk.', qty2: 2 }
    })
  })

  it('writes a group with kb, free and nested group children in input order', async () => {
    const { h, fw } = await setup()
    const result = await add(h, {
      rows: [
        {
          type: 'group',
          name: 'Technik',
          children: [
            { type: 'kb', kbItem: 'kbA1' },
            { type: 'free', name: 'Setup', price: 10 },
            { type: 'group', name: 'Inner', children: [{ type: 'free', name: 'Leaf' }] }
          ]
        }
      ]
    })

    expect(result.isError).toBe(false)
    const group = budget(fw)[2] as Row
    expect(withoutUids(group)).toEqual({
      name: 'Technik',
      content: { price: 0, selectedQuantity: 1 },
      subRows: [
        { ref: 'kbA1', name: 'Speaker', content: { ...CONVERTED_DEFAULTS, price: 50, quantityType: 'Stk.' } },
        { name: 'Setup', content: { price: 10, selectedQuantity: 1 } },
        {
          name: 'Inner',
          content: { price: 0, selectedQuantity: 1 },
          subRows: [{ name: 'Leaf', content: { price: 0, selectedQuantity: 1 } }]
        }
      ]
    })
    const uids = [group.uid, ...(group.subRows ?? []).map((row) => row.uid)]
    expect(new Set(uids).size).toBe(uids.length)
  })

  it('places rows by parentRow and position; a later item counts positions on the list as earlier items left it', async () => {
    const { h, fw } = await setup()
    const result = await add(h, {
      rows: [
        { type: 'free', name: 'First', position: 0 },
        { type: 'free', name: 'Second', position: 2 },
        { type: 'free', name: 'Drinks', parentRow: 'g1', position: 0 },
        { type: 'free', name: 'Dessert', parentRow: 'g1' },
        { type: 'free', name: 'Under venue', parentRow: 'r1' }
      ]
    })

    expect(result.isError).toBe(false)
    const rows = budget(fw)
    expect(rows.map((row) => row.name)).toEqual(['First', 'Venue', 'Second', 'Catering'])
    expect(rows[3]?.subRows?.map((row) => row.name)).toEqual(['Drinks', 'Food', 'Dessert'])
    expect(rows[1]?.subRows?.map((row) => row.name)).toEqual(['Under venue'])
    expect(
      (result.body.rows as Array<Record<string, unknown>>).map((row) => [row.name, row.parentRow, row.position])
    ).toEqual([
      ['First', null, 0],
      ['Second', null, 2],
      ['Drinks', 'g1', 0],
      ['Dessert', 'g1', 2],
      ['Under venue', 'r1', 0]
    ])
  })

  it('finds a parentRow nested deeper and reads a budget stored as an object with numeric keys', async () => {
    const { h, fw } = await setup()
    const result = await add(h, { offer: 'o4', rows: [{ type: 'free', name: 'Wine', parentRow: 'g1a' }] })

    expect(result.isError).toBe(false)
    const rows = budget(fw, 'o4')
    expect(Array.isArray(rows)).toBe(true)
    expect(rows[1]?.subRows?.[0]?.subRows?.map((row) => row.name)).toEqual(['Wine'])
  })

  it('refuses an unknown parentRow (E28) with no write', async () => {
    const { h, world } = await setup()
    const result = await add(h, { rows: [{ type: 'free', name: 'X', parentRow: 'zzz' }] })

    expect(result.isError).toBe(true)
    expect(result.body.error).toBe('parentRow "zzz" is not in the budget of offer o1.')
    expect(writeSummary(world)).toEqual([])
  })

  it('refuses a position outside 0..length (E28) with no write', async () => {
    const { h, world } = await setup()
    const result = await add(h, {
      rows: [
        { type: 'free', name: 'A' },
        { type: 'free', name: 'B', parentRow: 'g1', position: 2 }
      ]
    })

    expect(result.isError).toBe(true)
    expect(result.body.error).toBe('position 2 is outside 0..1.')
    expect(writeSummary(world)).toEqual([])
  })

  it('refuses parentRow and position inside children (schema)', async () => {
    const { h } = await setup()
    const result = await schemaText(h, {
      rows: [{ type: 'group', name: 'G', children: [{ type: 'free', name: 'C', position: 0 }] }]
    })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('position')
  })

  it('refuses a uid in a row (schema)', async () => {
    const { h } = await setup()
    const result = await schemaText(h, { rows: [{ type: 'free', name: 'C', uid: 'mine' }] })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('uid')
  })
})

describe('campaigns_add_budget_rows: totals and writes (AC-P3)', () => {
  it('PUTs the budget, then PATCHes total and allocated computed by budgetMath on the stored list', async () => {
    const { h, fw, world } = await setup()
    const result = await add(h, {
      rows: [
        { type: 'kb', kbItem: 'kbA' },
        { type: 'kb', kbItem: 'kbR' },
        { type: 'free', name: 'Transport', price: 250, q1: 2, parentRow: 'g1' }
      ]
    })

    expect(result.isError).toBe(false)
    const rows = budget(fw) as BudgetRow[]
    const total = calculateTotal(rows, false, 'CHF', RATES)
    const allocated = calculateAllocated(rows)
    expect(total).toBeGreaterThan(2000)
    expect(allocated).toBe(300)
    expect(planner(fw)).toMatchObject({ total, allocated, name: 'Gala', owner: 'boss' })
    expect(result.body).toMatchObject({ offer: 'o1', total, allocated, retries: 0 })
    expect(writeSummary(world)).toEqual([
      'PUT plannerBudgets/o1.json',
      'PATCH /.json planner/o1/total planner/o1/allocated history/<key> history/<key> history/<key>'
    ])
    expect(result.body.written).toEqual([
      { method: 'PUT', path: 'plannerBudgets/o1' },
      { method: 'PATCH', path: '/' }
    ])
  })

  it('returns uid, ref, name, place and amount of every top-level row', async () => {
    const { h, fw } = await setup()
    const result = await add(h, {
      rows: [
        { type: 'kb', kbItem: 'kbA1', price: 80, q1: 2 },
        { type: 'kb', kbItem: 'kbR' }
      ]
    })

    const rows = budget(fw)
    expect(result.body.rows).toEqual([
      { uid: rows[2]?.uid, ref: 'kbA1', name: 'Speaker', parentRow: null, position: 2, amount: 160 },
      { uid: rows[3]?.uid, ref: 'kbR', name: 'Agency fee', parentRow: null, position: 3, amount: expect.any(Number) }
    ])
    const amount = (result.body.rows as Array<{ amount: number }>)[1]?.amount ?? 0
    expect(amount).toBeGreaterThan(50)
  })

  it('logs the PUT with if-match and the PATCH without, with no values (AC-P11)', async () => {
    const { h } = await setup()
    await add(h, { rows: [{ type: 'free', name: 'Secret name', price: 99 }] })

    const lines = h.logs.filter((line) => line.tool === ADD) as unknown as Array<Record<string, unknown>>
    expect(lines.map((line) => [line.method, line.path, line.ifMatch, line.retries, line.httpStatus])).toEqual([
      ['PUT', 'plannerBudgets/o1', true, 0, 200],
      ['PATCH', '/', false, 0, 200]
    ])
    expect(JSON.stringify(h.logs)).not.toContain('Secret name')
  })

  it('a refusal after reads logs the planned PUT with httpStatus null (AC-P11)', async () => {
    const { h } = await setup()
    await add(h, { offer: 'o9', rows: [{ type: 'free', name: 'X' }] })

    const lines = h.logs.filter((line) => line.tool === ADD) as unknown as Array<Record<string, unknown>>
    expect(lines.map((line) => [line.method, line.path, line.httpStatus])).toEqual([['PUT', 'plannerBudgets/o9', null]])
  })

  it('reports rows saved and totals not updated (E23) when the totals PATCH fails', async () => {
    const { h, fw, world } = await setup()
    fw.beforeWrite = (method) => {
      if (method === 'PUT') fw.rtdbStatus.push(500)
    }
    const result = await add(h, { rows: [{ type: 'free', name: 'Extra', price: 5 }] })

    expect(result.isError).toBe(true)
    expect(result.body.error).toContain(
      `${ADD} stopped after a partial write. Saved: plannerBudgets/o1. Not saved: planner/o1/total, planner/o1/allocated, 2 history records.`
    )
    expect(result.body.error).toContain(
      'The rows are saved, but total and allocated of the offer and the history records are not written.'
    )
    expect(history(fw)).toEqual([])
    expect(budget(fw)).toHaveLength(3)
    expect(planner(fw).total).toBe(2000)
    expect(writeSummary(world)).toEqual([
      'PUT plannerBudgets/o1.json',
      'PATCH /.json planner/o1/total planner/o1/allocated history/<key> history/<key>'
    ])
  })
})

describe('campaigns_add_budget_rows: history records as the budget table writes them (P36)', () => {
  it('a free row writes one updated record per field a user would edit in the new empty row', async () => {
    const { h, fw } = await setup()
    const result = await add(h, {
      rows: [{ type: 'free', name: 'Transport', price: 250, q1: 2, u1: 'Stk.', q2: 3, u2: 'Std.', pdfDescription: 'x' }]
    })

    expect(result.isError).toBe(false)
    expect(edits(fw)).toEqual([
      ['', 'name', '', 'Transport'],
      ['Transport', 'price', 0, 250],
      ['Transport', 'selectedQuantity', 1, 2],
      ['Transport', 'quantityType', '', 'Stk.'],
      ['Transport', 'qty2', '', 3],
      ['Transport', 'quantity2Unit', '', 'Std.']
    ])
    const [first] = history(fw)
    expect(first).toEqual({
      uid: expect.stringMatching(PUSH_KEY),
      module: 'budget',
      item: '',
      action: 'updated',
      from: '',
      to: 'Transport',
      field: 'name',
      date: NOW_JSON,
      user: ME,
      source: 'o1',
      type: 'string',
      valueType: 'string'
    })
    const keys = Object.keys(fw.rtdb[WS]?.history as Record<string, unknown>)
    expect(keys).toEqual(history(fw).map((record) => record.uid))
    expect(new Set(keys).size).toBe(6)
  })

  it('a free row with only a name writes only the name record (price 0 and quantity 1 are the empty-row values)', async () => {
    const { h, fw } = await setup()
    await add(h, { rows: [{ type: 'free', name: 'Extra', price: 0, q1: 1 }] })

    expect(edits(fw)).toEqual([['', 'name', '', 'Extra']])
  })

  it('a KB row without overrides, or with overrides equal to the KB values, writes no record', async () => {
    const { h, fw } = await setup()
    await add(h, {
      rows: [
        { type: 'kb', kbItem: 'kbA' },
        { type: 'kb', kbItem: 'kbA1', name: 'Speaker', price: 50, u1: 'Stk.', pdfDescription: 'only text' }
      ]
    })

    expect(history(fw)).toEqual([])
  })

  it('a KB row writes a record for each override that changes a value, from the converted KB value', async () => {
    const { h, fw } = await setup()
    await add(h, { rows: [{ type: 'kb', kbItem: 'kbA1', name: 'Big speaker', price: 75, q1: 3, u2: 'Std.' }] })

    expect(edits(fw)).toEqual([
      ['Speaker', 'name', 'Speaker', 'Big speaker'],
      ['Big speaker', 'price', 50, 75],
      ['Big speaker', 'selectedQuantity', 1, 3],
      ['Big speaker', 'quantity2Unit', '', 'Std.']
    ])
  })

  it('a KB row without a name writes item "" in its field records, as useHistory', async () => {
    const { h, fw } = await setup()
    await add(h, { rows: [{ type: 'kb', kbItem: 'kbN', price: 6 }] })

    expect(history(fw).map((record) => record.item)).toEqual([''])
  })

  it('a group writes its name record and the records of its children in input order', async () => {
    const { h, fw } = await setup()
    await add(h, {
      rows: [
        {
          type: 'group',
          name: 'Technik',
          children: [
            { type: 'kb', kbItem: 'kbA1' },
            { type: 'free', name: 'Setup', price: 10 }
          ]
        }
      ]
    })

    expect(edits(fw)).toEqual([
      ['', 'name', '', 'Technik'],
      ['', 'name', '', 'Setup'],
      ['Setup', 'price', 0, 10]
    ])
  })

  it('writes the history records only once after a re-apply (AC-P6)', async () => {
    const { h, fw } = await setup()
    let changed = false
    fw.beforeWrite = (method, path) => {
      if (changed || method !== 'PUT' || !path.endsWith('plannerBudgets/o1')) return
      changed = true
      budget(fw)[0] = { ...(budget(fw)[0] as Row), name: 'Venue (renamed)' }
    }
    const result = await add(h, { rows: [{ type: 'free', name: 'New', price: 1 }] })

    expect(result.body.retries).toBe(1)
    expect(edits(fw)).toEqual([
      ['', 'name', '', 'New'],
      ['New', 'price', 0, 1]
    ])
  })
})

describe('campaigns_add_budget_rows: concurrency (AC-P6)', () => {
  it('re-applies on a stale ETag, keeps the other user change and inserts the rows once with the same uids', async () => {
    const { h, fw } = await setup()
    const uids: string[] = []
    let changed = false
    fw.beforeWrite = (method, path, body) => {
      if (method !== 'PUT' || !path.endsWith('plannerBudgets/o1')) return
      uids.push(((body as Row[])[2] as Row).uid)
      if (changed) return
      changed = true
      const rows = budget(fw)
      rows[0] = { ...(rows[0] as Row), name: 'Venue (renamed)' }
    }
    const result = await add(h, { rows: [{ type: 'free', name: 'New', price: 1 }] })

    expect(result.isError).toBe(false)
    expect(result.body.retries).toBe(1)
    const rows = budget(fw)
    expect(rows.map((row) => row.name)).toEqual(['Venue (renamed)', 'Catering', 'New'])
    expect(uids).toHaveLength(2)
    expect(uids[0]).toBe(uids[1])
    expect((result.body.rows as Array<{ uid: string }>)[0]?.uid).toBe(uids[0])
  })

  it('places by uid on the fresh list when another user inserted a row above', async () => {
    const { h, fw } = await setup()
    let changed = false
    fw.beforeWrite = (method, path) => {
      if (changed || method !== 'PUT' || !path.endsWith('plannerBudgets/o1')) return
      changed = true
      budget(fw).unshift({ uid: 'x0', name: 'Other user row', content: { price: 1, selectedQuantity: 1 } })
    }
    const result = await add(h, { rows: [{ type: 'free', name: 'Wine', parentRow: 'g1' }] })

    expect(result.isError).toBe(false)
    const rows = budget(fw)
    expect(rows.map((row) => row.uid)).toEqual(['x0', 'r1', 'g1'])
    expect(rows[2]?.subRows?.map((row) => row.name)).toEqual(['Food', 'Wine'])
  })

  it('after four 412s returns a conflict (E16) and writes nothing more', async () => {
    const { h, fw, world } = await setup()
    let price = 1000
    fw.beforeWrite = (method, path) => {
      if (method !== 'PUT' || !path.endsWith('plannerBudgets/o1')) return
      const rows = budget(fw)
      rows[0] = { ...(rows[0] as Row), content: { price: price++, selectedQuantity: 1 } }
    }
    const result = await add(h, { rows: [{ type: 'free', name: 'New' }] })

    expect(result.isError).toBe(true)
    expect(result.body.error).toBe(
      `plannerBudgets/o1 changed 4 times while the MCP wrote it, so the change was not saved. Nothing more was written. Try the call again.`
    )
    expect(writeSummary(world)).toEqual([
      'PUT plannerBudgets/o1.json',
      'PUT plannerBudgets/o1.json',
      'PUT plannerBudgets/o1.json',
      'PUT plannerBudgets/o1.json'
    ])
    expect(budget(fw).map((row) => row.name)).toEqual(['Venue', 'Catering'])
    expect(planner(fw).total).toBe(2000)
  })
})

describe('campaigns_add_budget_rows: refusals', () => {
  it('refuses without offers/budget:manage (E17) with no RTDB request (AC-P7)', async () => {
    const { h, world } = await setup({ permissions: ['campaigns_app:view', 'campaigns_app/offers:view'] })
    const result = await add(h, { rows: [{ type: 'free', name: 'X' }] })

    expect(result.isError).toBe(true)
    expect(result.body.error).toBe(
      `You lack campaigns_app/offers/budget:manage in workspace ${WS}, so ${ADD} cannot write.`
    )
    expect(rtdbRequests(world)).toEqual([])
  })

  it('refuses a missing offer (E21), an archived offer (E26) and a hidden offer (E18) with no write', async () => {
    const { h, world } = await setup()
    const missing = await add(h, { offer: 'o9', rows: [{ type: 'free', name: 'X' }] })
    const archived = await add(h, { offer: 'o2', rows: [{ type: 'free', name: 'X' }] })
    const hidden = await add(h, { offer: 'o3', rows: [{ type: 'free', name: 'X' }] })

    expect(missing.body.error).toBe(`Offer "o9" does not exist in workspace ${WS}. Nothing was written.`)
    expect(archived.body.error).toBe('Offer o2 is archived and cannot be changed.')
    expect(hidden.body.error).toBe('Offer o3 is not found or is hidden from you. Nothing was written.')
    expect(writeSummary(world)).toEqual([])
  })

  it('refuses an offer id with a slash before any request', async () => {
    const { h, world } = await setup()
    const result = await add(h, { offer: 'o1/x', rows: [{ type: 'free', name: 'X' }] })

    expect(result.isError).toBe(true)
    expect(rtdbRequests(world)).toEqual([])
  })
})
