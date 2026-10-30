import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MAX_WRITES_PER_MINUTE } from '../src/api/client.js'
import type { FirebaseWriteCall } from '../src/callLog.js'
import {
  conditionalWrite,
  MAX_REAPPLIES,
  type PutResult,
  type RtdbWriter
} from '../src/firebase/campaigns/writes/conditional.js'
import {
  checkPersonalInput,
  IDENTITY_INPUT_FIELDS,
  OFFER_UPDATE_FIELDS,
  PERSONAL_INPUT_FIELDS,
  WRITE_RULES,
  WRITE_TOOLS,
  type WriteOp,
  type WriteRefusal,
  type WriteTool,
  writeRefusal
} from '../src/firebase/policy/writes.js'
import { type CampaignsWriter, openWriter } from '../src/firebase/write.js'
import {
  type FirebaseWriteToolContext,
  runFirebaseWriteTool,
  WRITE_TOOL_ANNOTATIONS,
  writeInput
} from '../src/tools/run.js'
import { DB_HOST, firebaseSetup, ME, NULL_ETAG, rtdbRequests } from './firebaseFake.js'
import { type Harness, WS_A, WS_B } from './harness.js'

const WS = WS_A
const CTX = { workspace: WS, uid: ME }

const EXPECTED_RULES: Array<[string, WriteTool, 'put' | 'patch', string]> = [
  ['W01', 'campaigns_add_timesheet_report', 'put', 'workspaces/{ws}/timesheet/{id}'],
  ['W02', 'campaigns_add_timesheet_report', 'put', 'workspaces/{ws}/budgets/{id}'],
  ['W03', 'campaigns_update_timesheet_report', 'put', 'workspaces/{ws}/timesheet/{id}'],
  ['W04', 'campaigns_update_timesheet_report', 'put', 'workspaces/{ws}/budgets/{id}'],
  ['W05', 'campaigns_create_offer', 'put', 'workspaces/{ws}/projectCounter'],
  ['W06', 'campaigns_create_offer', 'patch', 'workspaces/{ws}/planner/{id}'],
  ['W07', 'campaigns_create_offer', 'patch', 'workspaces/{ws}/plannerBudgets/{id}'],
  ['W08', 'campaigns_create_offer', 'patch', 'workspaces/{ws}/taskBoards/{id}'],
  ['W09', 'campaigns_create_offer', 'patch', 'workspaces/{ws}/taskBoards/{id}/prefix'],
  ['W10', 'campaigns_create_offer', 'patch', 'externalIds/{id}'],
  ['W11', 'campaigns_update_offer', 'patch', 'workspaces/{ws}/planner/{id}/{field}'],
  ['W12', 'campaigns_update_offer', 'patch', 'workspaces/{ws}/deals/{id}/{field}'],
  ['W13', 'campaigns_add_budget_rows', 'put', 'workspaces/{ws}/plannerBudgets/{id}'],
  ['W14', 'campaigns_add_budget_rows', 'patch', 'workspaces/{ws}/planner/{id}/{field}'],
  ['W15', 'campaigns_create_lead', 'patch', 'workspaces/{ws}/deals/{id}'],
  ['W16', 'campaigns_create_lead', 'patch', 'workspaces/{ws}/taskBoards/{id}'],
  ['W17', 'campaigns_create_lead', 'patch', 'externalIds/{id}']
]

const EXPECTED_FIELDS: Record<string, string[]> = {
  W11: [...OFFER_UPDATE_FIELDS, 'updatedAt', 'updatedBy'],
  W12: ['name', 'status', 'updatedAt', 'updatedBy'],
  W14: ['total', 'allocated']
}

function concretePath(pattern: readonly string[], field = 'name') {
  return pattern
    .map((part) => (part === '{ws}' ? WS : part === '{id}' ? 'k1' : part === '{field}' ? field : part))
    .join('/')
}

function sampleValue(path: string): unknown {
  if (path.startsWith('externalIds/')) return { source: 'k1', workspace: WS }
  if (path.endsWith('projectCounter')) return 7
  if (path.endsWith('/prefix')) return 'AB'
  if (/\/(total|allocated)$/.test(path)) return 5
  if (/\/(name|status|[a-z_]+)$/.test(path) && path.split('/').length === 5) return 'x'
  return { v: 1, owner: ME }
}

function opFor(rule: (typeof WRITE_RULES)[number], field?: string): WriteOp {
  const path = concretePath(rule.pattern, field ?? rule.fields?.[0])
  const value = sampleValue(path)
  return rule.op === 'put'
    ? { method: 'PUT', path, body: value }
    : { method: 'PATCH', path: '', body: { [path]: value } }
}

describe('write path table (CONTRACT-phase5 §2.1)', () => {
  it('the code table equals the contract copy', () => {
    expect(WRITE_RULES.map((rule) => [rule.id, rule.tool, rule.op, rule.pattern.join('/')])).toEqual(EXPECTED_RULES)
    const fields = Object.fromEntries(WRITE_RULES.filter((rule) => rule.fields).map((rule) => [rule.id, rule.fields]))
    expect(fields).toEqual(EXPECTED_FIELDS)
  })

  const allowed = WRITE_RULES.map((rule) => [rule.id, rule] as const)
  it('has one allowed case per table row', () => expect(allowed).toHaveLength(EXPECTED_RULES.length))

  it.each(allowed)('%s is allowed for its tool', (_id, rule) => {
    expect(writeRefusal(rule.tool, opFor(rule), CTX)).toBeNull()
  })

  it.each(allowed)('%s is refused for every tool without the same row', (_id, rule) => {
    const others = WRITE_TOOLS.filter(
      (tool) =>
        !WRITE_RULES.some(
          (other) => other.tool === tool && other.op === rule.op && other.pattern.join('/') === rule.pattern.join('/')
        )
    )
    expect(others.length).toBeGreaterThan(0)
    for (const tool of others) expect(writeRefusal(tool, opFor(rule), CTX)).toBe('table')
  })

  it('every listed field of a field row is allowed, and a field outside the list is refused', () => {
    for (const rule of WRITE_RULES.filter((candidate) => candidate.fields)) {
      for (const field of rule.fields ?? []) {
        const value = field === 'updatedBy' ? ME : field === 'total' || field === 'allocated' ? 1 : 'x'
        const path = concretePath(rule.pattern, field)
        expect(writeRefusal(rule.tool, { method: 'PATCH', path: '', body: { [path]: value } }, CTX)).toBeNull()
      }
      const path = concretePath(rule.pattern, 'somethingElse')
      expect(writeRefusal(rule.tool, { method: 'PATCH', path: '', body: { [path]: 'x' } }, CTX)).toBe('table')
    }
  })

  it('a PATCH of one node with deep keys is checked per key (W14 as M4)', () => {
    const node = `workspaces/${WS}/planner/k1`
    expect(
      writeRefusal('campaigns_add_budget_rows', { method: 'PATCH', path: node, body: { total: 1, allocated: 0 } }, CTX)
    ).toBeNull()
    expect(
      writeRefusal('campaigns_add_budget_rows', { method: 'PATCH', path: node, body: { total: 1, name: 'x' } }, CTX)
    ).toBe('table')
  })

  const ws = `workspaces/${WS}`
  const denyCases: Array<[WriteRefusal, string, WriteTool, WriteOp]> = [
    [
      'X1',
      'PUT under projects',
      'campaigns_add_timesheet_report',
      { method: 'PUT', path: `${ws}/projects/p1`, body: { list: [1] } }
    ],
    [
      'X1',
      'root PATCH key under projects',
      'campaigns_update_offer',
      { method: 'PATCH', path: '', body: { [`${ws}/projects/p1/list`]: [1] } }
    ],
    [
      'X2',
      'PUT under secrets',
      'campaigns_add_timesheet_report',
      { method: 'PUT', path: `${ws}/secrets/key`, body: 'x' }
    ],
    [
      'X3',
      'deals costCenter as a key',
      'campaigns_update_offer',
      { method: 'PATCH', path: '', body: { [`${ws}/deals/k1/costCenter`]: 'c1' } }
    ],
    [
      'X3',
      'deals costCenter inside a lead body',
      'campaigns_create_lead',
      { method: 'PATCH', path: '', body: { [`${ws}/deals/k1`]: { name: 'L', costCenter: 'c1' } } }
    ],
    [
      'X4',
      'DELETE',
      'campaigns_add_timesheet_report',
      { method: 'DELETE', path: `${ws}/timesheet/k1`, body: undefined }
    ],
    ['X5', 'PUT of null', 'campaigns_add_timesheet_report', { method: 'PUT', path: `${ws}/timesheet/k1`, body: null }],
    [
      'X5',
      'PATCH key with null',
      'campaigns_update_offer',
      { method: 'PATCH', path: '', body: { [`${ws}/planner/k1/name`]: null } }
    ],
    ['X6', 'PUT of []', 'campaigns_add_timesheet_report', { method: 'PUT', path: `${ws}/budgets/p1`, body: [] }],
    ['X6', 'PUT of {}', 'campaigns_add_timesheet_report', { method: 'PUT', path: `${ws}/timesheet/k1`, body: {} }],
    [
      'X7',
      'owner of another user',
      'campaigns_add_timesheet_report',
      { method: 'PUT', path: `${ws}/timesheet/k1`, body: { owner: 'someone' } }
    ],
    [
      'X7',
      'updatedBy of another user',
      'campaigns_update_offer',
      { method: 'PATCH', path: '', body: { [`${ws}/planner/k1/updatedBy`]: 'someone' } }
    ],
    [
      'X7',
      'accountManager in a lead',
      'campaigns_create_lead',
      { method: 'PATCH', path: '', body: { [`${ws}/deals/k1`]: { name: 'L', accountManager: 'someone' } } }
    ],
    [
      'X8',
      'another workspace',
      'campaigns_add_timesheet_report',
      { method: 'PUT', path: `workspaces/${WS_B}/timesheet/k1`, body: { owner: ME } }
    ],
    [
      'X9',
      'externalIds of another workspace',
      'campaigns_create_offer',
      { method: 'PATCH', path: '', body: { 'externalIds/e1': { source: 'k1', workspace: WS_B } } }
    ],
    [
      'X9',
      'externalIds with an extra key',
      'campaigns_create_offer',
      { method: 'PATCH', path: '', body: { 'externalIds/e1': { source: 'k1', workspace: WS, x: 1 } } }
    ],
    [
      'X9',
      'a part of an externalIds entry',
      'campaigns_create_lead',
      { method: 'PATCH', path: '', body: { 'externalIds/e1/workspace': WS } }
    ],
    [
      'X10',
      'update offer sets archived',
      'campaigns_update_offer',
      { method: 'PATCH', path: '', body: { [`${ws}/planner/k1/archived`]: true } }
    ],
    [
      'X10',
      'update offer sets total',
      'campaigns_update_offer',
      { method: 'PATCH', path: '', body: { [`${ws}/planner/k1/total`]: 1 } }
    ],
    [
      'X10',
      'update offer sets prefix',
      'campaigns_update_offer',
      { method: 'PATCH', path: '', body: { [`${ws}/planner/k1/prefix`]: 'AB' } }
    ]
  ]

  it.each(denyCases)('%s refuses: %s', (reason, _name, tool, op) => {
    expect(writeRefusal(tool, op, CTX)).toBe(reason)
  })

  it('every deny row X1–X10 has a case', () => {
    expect([...new Set(denyCases.map(([reason]) => reason))].sort()).toEqual(
      ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'X8', 'X9', 'X10'].sort()
    )
  })

  it('refuses paths outside the table and PATCH bodies that are not objects', () => {
    expect(
      writeRefusal('campaigns_add_timesheet_report', { method: 'PUT', path: `${ws}/tags/t1`, body: { v: 1 } }, CTX)
    ).toBe('table')
    expect(writeRefusal('campaigns_create_lead', { method: 'PATCH', path: '', body: [] }, CTX)).toBe('shape')
    expect(writeRefusal('campaigns_create_lead', { method: 'PUT', path: '', body: { v: 1 } }, CTX)).toBe('shape')
  })
})

describe('identity fields (AC-P8)', () => {
  it.each(WRITE_TOOLS)('%s: the shared input schema refuses every identity field with E29', (tool) => {
    expect(tool).toMatch(/^campaigns_/)
    const schema = writeInput({ name: z.string().optional() })
    for (const field of IDENTITY_INPUT_FIELDS) {
      const result = schema.safeParse({ name: 'x', [field]: 'someone' })
      expect(result.success).toBe(false)
      expect(result.error?.issues[0]?.message).toBe(`"${field}" cannot be set. The MCP sets it from your login.`)
    }
    expect(schema.safeParse({ name: 'x' }).success).toBe(true)
    expect(schema.safeParse({ other: 1 }).error?.issues[0]?.message).toBe('"other" is not an input of this tool.')
  })

  it.each(WRITE_TOOLS)(
    '%s: a written record must carry the token uid in owner / updatedBy / createdBy / accountManager',
    (tool) => {
      const rule = WRITE_RULES.find((candidate) => candidate.tool === tool && candidate.pattern[0] === 'workspaces')
      if (!rule) throw new Error(`no rule for ${tool}`)
      for (const field of ['owner', 'updatedBy', 'createdBy', 'accountManager']) {
        const fieldRow = Boolean(rule.fields)
        const path = concretePath(rule.pattern, fieldRow ? 'updatedBy' : undefined)
        const foreign = fieldRow ? 'someone' : { v: 1, [field]: 'someone' }
        const own = fieldRow ? ME : { v: 1, [field]: ME }
        const op = (value: unknown): WriteOp =>
          rule.op === 'put'
            ? { method: 'PUT', path, body: value }
            : { method: 'PATCH', path: '', body: { [path]: value } }
        if (fieldRow && rule.id === 'W14') {
          expect(writeRefusal(tool, op(foreign), CTX)).toBe('X7')
          continue
        }
        expect(writeRefusal(tool, op(foreign), CTX)).toBe('X7')
        expect(writeRefusal(tool, op(own), CTX)).toBeNull()
      }
    }
  )
})

describe('personal input fields (P21, P33, AC-P10)', () => {
  it.each(WRITE_TOOLS)('%s refuses its personal fields while the switch is off', (tool) => {
    for (const field of PERSONAL_INPUT_FIELDS[tool]) {
      expect(() => checkPersonalInput(tool, { [field]: 'x' }, false)).toThrow(
        `"${field}" is personal data. Writing it needs COLADA_ALLOW_PERSONAL_DATA=true. Nothing was written.`
      )
      expect(() => checkPersonalInput(tool, { [field]: 'x' }, true)).not.toThrow()
    }
    expect(() => checkPersonalInput(tool, { hours: 1 }, false)).not.toThrow()
  })

  it('matches CONTRACT-phase5 §3', () => {
    expect(PERSONAL_INPUT_FIELDS).toEqual({
      campaigns_add_timesheet_report: ['description'],
      campaigns_update_timesheet_report: ['description'],
      campaigns_create_offer: ['person', 'participants', 'notes'],
      campaigns_update_offer: ['person', 'participants', 'notes'],
      campaigns_add_budget_rows: [],
      campaigns_create_lead: ['name', 'contact', 'summary']
    })
  })
})

describe('conditionalWrite (P14)', () => {
  function stubWriter(results: Array<'conflict' | 'saved'>) {
    const puts: Array<{ value: unknown; ifMatch: string; retries: number }> = []
    let version = 0
    const writer: RtdbWriter = {
      read: async () => ({ value: { rows: ['a'] }, etag: 'e0' }),
      put: async (_path, value, ifMatch, retries): Promise<PutResult> => {
        puts.push({ value, ifMatch, retries })
        if (results.shift() === 'saved') return { saved: true }
        version++
        return { saved: false, conflict: { value: { rows: ['a', `other${version}`] }, etag: `e${version}` } }
      }
    }
    return { writer, puts }
  }
  const addRow = (current: unknown) => {
    const value = current as { rows: string[] }
    return { rows: [...value.rows, 'mine'] }
  }

  it('412, 412, 200 → saved with 3 PUTs, each re-applied on the value of the last 412', async () => {
    const { writer, puts } = stubWriter(['conflict', 'conflict', 'saved'])
    const result = await conditionalWrite(writer, 'plannerBudgets/o1', addRow)
    expect(result).toEqual({ value: { rows: ['a', 'other2', 'mine'] }, retries: 2, written: true })
    expect(puts.map((put) => [put.ifMatch, put.retries])).toEqual([
      ['e0', 0],
      ['e1', 1],
      ['e2', 2]
    ])
  })

  it('four 412s → E16 and no fifth PUT', async () => {
    const { writer, puts } = stubWriter(['conflict', 'conflict', 'conflict', 'conflict', 'saved'])
    await expect(conditionalWrite(writer, 'plannerBudgets/o1', addRow)).rejects.toThrow(
      'plannerBudgets/o1 changed 4 times while the MCP wrote it, so the change was not saved.'
    )
    expect(puts).toHaveLength(MAX_REAPPLIES + 1)
  })

  it('sends no PUT when mutate leaves the value unchanged', async () => {
    const { writer, puts } = stubWriter(['saved'])
    const result = await conditionalWrite(writer, 'budgets/p1', (current) => current)
    expect(result).toEqual({ value: { rows: ['a'] }, retries: 0, written: false })
    expect(puts).toEqual([])
  })

  it('starts from a value read before, without a new GET', async () => {
    const { writer, puts } = stubWriter(['saved'])
    writer.read = async () => {
      throw new Error('no read expected')
    }
    await conditionalWrite(writer, 'budgets/p1', addRow, { value: { rows: ['b'] }, etag: 'e9' })
    expect(puts).toEqual([{ value: { rows: ['b', 'mine'] }, ifMatch: 'e9', retries: 0 }])
  })

  it('gives mutate a copy, so a failed try leaves nothing behind', async () => {
    const { writer } = stubWriter(['conflict', 'saved'])
    const seen: unknown[] = []
    await conditionalWrite(writer, 'x', (current) => {
      seen.push(current)
      ;(current as { rows: string[] }).rows.push('mutated')
      return current
    })
    expect(seen[1]).toEqual({ rows: ['a', 'other1', 'mutated'] })
  })
})

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

const WRITE_PERMISSIONS = [
  'campaigns_app:view',
  'campaigns_app/timesheet/me:manage',
  'campaigns_app/offers:manage',
  'campaigns_app/offers/settings:manage',
  'campaigns_app/offers/budget:manage',
  'campaigns_app/leads:manage'
]

async function setup(permissions = WRITE_PERMISSIONS) {
  const result = await firebaseSetup()
  harnesses.push(result.h)
  result.fw.permissions = permissions
  result.fw.rtdb[WS] = { plannerBudgets: { o1: [{ uid: 'r1', name: 'Room', content: { price: 10 } }] } }
  return result
}

const PLANNED: FirebaseWriteCall = {
  app: 'campaigns',
  store: 'rtdb',
  method: 'PUT',
  path: 'plannerBudgets/o1',
  paths: null,
  ifMatch: true,
  retries: 0
}

async function runWrite(
  h: Harness,
  tool: WriteTool,
  body: (writer: CampaignsWriter, ctx: FirebaseWriteToolContext) => Promise<Record<string, unknown>>
) {
  const result = await runFirebaseWriteTool(h.app, tool, undefined, PLANNED, async (ctx) =>
    body(await openWriter(h.app, ctx, tool, { workspace: WS }), ctx)
  )
  const text = (result.content[0] as { text: string }).text
  return { isError: result.isError === true, body: JSON.parse(text) as Record<string, unknown> }
}

const writesTo = (world: Parameters<typeof rtdbRequests>[0]) =>
  rtdbRequests(world).filter((request) => request.method !== 'GET')

const addRow = (uid: string) => (current: unknown) => [
  ...((current as unknown[] | null) ?? []),
  { uid, content: { price: 1 } }
]

describe('writer against the fake RTDB', () => {
  it('a concurrent change is kept: the row is re-applied on the 412 value (AC-P6)', async () => {
    const { h, fw, world } = await setup()
    let changed = false
    fw.beforeWrite = () => {
      if (changed) return
      changed = true
      const list = (fw.rtdb[WS] as { plannerBudgets: { o1: unknown[] } }).plannerBudgets.o1
      list.push({ uid: 'theirs', content: { price: 2 } })
    }
    const result = await runWrite(h, 'campaigns_add_budget_rows', async (writer) => {
      const written = await conditionalWrite(writer, 'plannerBudgets/o1', addRow('mine'))
      return { retries: written.retries }
    })
    expect(result.isError).toBe(false)
    expect(result.body.retries).toBe(1)
    const stored = (fw.rtdb[WS] as { plannerBudgets: { o1: Array<{ uid: string }> } }).plannerBudgets.o1
    expect(stored.map((row) => row.uid)).toEqual(['r1', 'theirs', 'mine'])
    const puts = writesTo(world)
    expect(puts.map((request) => [request.method, request.headers['if-match'] !== undefined])).toEqual([
      ['PUT', true],
      ['PUT', true]
    ])
    expect(
      h.logs
        .filter((log) => log.tool === 'campaigns_add_budget_rows')
        .map((log) => [log.httpStatus, (log as FirebaseWriteCall).retries])
    ).toEqual([
      [412, 0],
      [200, 1]
    ])
  })

  it('four 412s → E16, exactly 4 PUTs and no further write', async () => {
    const { h, fw, world } = await setup()
    let n = 0
    fw.beforeWrite = () => {
      const list = (fw.rtdb[WS] as { plannerBudgets: { o1: unknown[] } }).plannerBudgets.o1
      list.push({ uid: `theirs${n++}`, content: {} })
    }
    const result = await runWrite(h, 'campaigns_add_budget_rows', async (writer) => {
      await conditionalWrite(writer, 'plannerBudgets/o1', addRow('mine'))
      await writer.patch('planner/o1', { total: 1, allocated: 0 })
      return {}
    })
    expect(result.body.error).toContain('plannerBudgets/o1 changed 4 times')
    expect(writesTo(world).map((request) => request.method)).toEqual(['PUT', 'PUT', 'PUT', 'PUT'])
  })

  it('a missing node is written with if-match null_etag (M3)', async () => {
    const { h, fw, world } = await setup()
    const result = await runWrite(h, 'campaigns_add_timesheet_report', async (writer) => {
      const saved = await writer.put('timesheet/t9', { uid: 't9', owner: ME, hours: 1 }, NULL_ETAG, 0)
      return { saved: saved.saved }
    })
    expect(result.body.saved).toBe(true)
    expect(writesTo(world)[0]?.headers['if-match']).toBe(NULL_ETAG)
    expect((fw.rtdb[WS] as { timesheet: Record<string, unknown> }).timesheet.t9).toEqual({
      uid: 't9',
      owner: ME,
      hours: 1
    })
  })

  it('a refused root PATCH writes nothing (whole PATCH fails) and returns E25', async () => {
    const { h, fw } = await setup()
    fw.externalIds.e1 = { source: 'other', workspace: WS_B }
    const result = await runWrite(h, 'campaigns_create_offer', async (writer) => {
      await writer.patch('', {
        'planner/k1': { name: 'Offer', owner: ME, archived: false },
        '/externalIds/e1': { source: 'k1', workspace: WS }
      })
      return {}
    })
    expect(result.body.error).toBe(
      'Firebase refused the write to / (expired token or a rules violation). Nothing was written by this request.'
    )
    expect((fw.rtdb[WS] as Record<string, unknown>).planner).toBeUndefined()
    expect(fw.externalIds.e1).toEqual({ source: 'other', workspace: WS_B })
  })

  it('a 401 renews the token once and sends the same write again', async () => {
    const { h, fw, world } = await setup()
    const result = await runWrite(h, 'campaigns_add_timesheet_report', async (writer) => {
      fw.rtdbStatus.push(401)
      const saved = await writer.put('timesheet/t9', { uid: 't9', owner: ME }, NULL_ETAG, 0)
      return { saved: saved.saved }
    })
    expect(result.body.saved).toBe(true)
    expect(writesTo(world)).toHaveLength(2)
  })

  it('without the :manage permission nothing is sent to RTDB (E17)', async () => {
    const { h, world } = await setup(['campaigns_app:view', 'campaigns_app/timesheet/me:view'])
    const result = await runWrite(h, 'campaigns_add_timesheet_report', async (writer) => {
      await writer.put('timesheet/t9', { owner: ME }, NULL_ETAG, 0)
      return {}
    })
    expect(result.body.error).toBe(
      `You lack campaigns_app/timesheet/me:manage in workspace ${WS}, so campaigns_add_timesheet_report cannot write.`
    )
    expect(rtdbRequests(world)).toHaveLength(0)
  })

  it('a path outside the table is refused before any write request (E24)', async () => {
    const { h, world } = await setup()
    const result = await runWrite(h, 'campaigns_add_timesheet_report', async (writer) => {
      await writer.put('projects/p1', { list: [1] }, NULL_ETAG, 0)
      return {}
    })
    expect(result.body.error).toBe(
      `PUT workspaces/${WS}/projects/p1 is not allowed for campaigns_add_timesheet_report. Nothing was written.`
    )
    expect(writesTo(world)).toHaveLength(0)
  })

  it('the write budget counts Firebase writes', async () => {
    const { h, world } = await setup()
    const result = await runWrite(h, 'campaigns_add_timesheet_report', async (writer) => {
      for (let i = 0; i <= MAX_WRITES_PER_MINUTE; i++) {
        await writer.put(`timesheet/t${i}`, { uid: `t${i}`, owner: ME }, NULL_ETAG, 0)
      }
      return {}
    })
    expect(result.body.error).toContain(`at most ${MAX_WRITES_PER_MINUTE} writes per minute`)
    expect(writesTo(world)).toHaveLength(MAX_WRITES_PER_MINUTE)
  })

  it('one log line per write, with method, paths, ifMatch, retries and status, and no body or token (AC-P11)', async () => {
    const { h } = await setup()
    await runWrite(h, 'campaigns_create_offer', async (writer) => {
      await writer.put('projectCounter', 1, NULL_ETAG, 0)
      await writer.patch('', {
        'planner/k1': { name: 'SECRET-BODY', owner: ME },
        '/externalIds/e9': { source: 'k1', workspace: WS }
      })
      return {}
    })
    const lines = h.logs.filter((log) => log.tool === 'campaigns_create_offer')
    expect(lines.map((line) => Object.keys(line).sort())).toEqual([
      [
        'app',
        'httpStatus',
        'ifMatch',
        'method',
        'path',
        'paths',
        'realm',
        'retries',
        'store',
        'time',
        'tool',
        'user',
        'workspace'
      ],
      [
        'app',
        'httpStatus',
        'ifMatch',
        'method',
        'path',
        'paths',
        'realm',
        'retries',
        'store',
        'time',
        'tool',
        'user',
        'workspace'
      ]
    ])
    expect(lines.map((line) => line as unknown as FirebaseWriteCall & { httpStatus: number })).toMatchObject([
      { method: 'PUT', path: 'projectCounter', paths: null, ifMatch: true, retries: 0, httpStatus: 200 },
      {
        method: 'PATCH',
        path: '/',
        paths: ['planner/k1', '/externalIds/e9'],
        ifMatch: false,
        retries: 0,
        httpStatus: 200
      }
    ])
    const text = JSON.stringify(h.logs)
    expect(text).not.toContain('SECRET-BODY')
    expect(text).not.toContain('auth=')
    expect(text).not.toContain('eyJ')
    expect(text).not.toContain(DB_HOST)
  })

  it('a refusal before any write still writes one line, without a write status', async () => {
    const { h } = await setup(['campaigns_app:view'])
    await runWrite(h, 'campaigns_create_lead', async () => ({}))
    const lines = h.logs.filter((log) => log.tool === 'campaigns_create_lead')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ method: 'PUT', path: 'plannerBudgets/o1', retries: 0 })
  })
})

describe('write tool annotations (P7, AC-P11)', () => {
  it('are destructive and not read-only', () => {
    expect(WRITE_TOOL_ANNOTATIONS).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false })
  })
})
