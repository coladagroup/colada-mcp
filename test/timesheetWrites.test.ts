import { afterEach, describe, expect, it } from 'vitest'
import { openWriter } from '../src/firebase/write.js'
import { runFirebaseWriteTool } from '../src/tools/run.js'
import { DB_HOST, firebaseSetup, firestoreRequests, ME, NULL_ETAG, rtdbRequests } from './firebaseFake.js'
import { type Harness, WS_A } from './harness.js'

const WS = WS_A
const ADD = 'campaigns_add_timesheet_report'
const UPDATE = 'campaigns_update_timesheet_report'
const MANAGE = ['campaigns_app:view', 'campaigns_app/timesheet/me:manage']

const T1 = {
  uid: 't1',
  owner: ME,
  date: '2026-09-02',
  hours: 2,
  minutes: 30,
  project: 'p1',
  entity: 'r1b',
  account: 'a1',
  tag: 'g1',
  description: 'met John'
}
const OTHER_COPY = { uid: 'x9', owner: 'other', date: '2026-09-02', hours: 1, minutes: 0, project: 'p1' }

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

async function setup(options: { allowPersonalData?: boolean; permissions?: string[] } = {}) {
  const result = await firebaseSetup({ allowPersonalData: options.allowPersonalData })
  harnesses.push(result.h)
  result.fw.permissions = options.permissions ?? MANAGE
  result.fw.rtdb[WS] = {
    timesheet: {
      t1: T1,
      t2: { uid: 't2', owner: ME, date: '2026-09-03', hours: 1, minutes: 0, project: 's1', account: 'a1' },
      t3: { uid: 't3', owner: 'other', date: '2026-09-02', hours: 3, minutes: 0, project: 'p1', entity: 'r2' },
      t4: { uid: 't4', owner: ME, date: '2026-09-04', hours: 1, minutes: 0, project: 'p1', entity: 'r2' }
    },
    projects: {
      p1: { uid: 'p1', name: 'Fair', owner: 'boss', deputies: [ME] },
      p2: { uid: 'p2', name: 'Hidden', owner: 'boss', isPrivate: 'true' },
      p3: { uid: 'p3', name: 'Gala', owner: 'boss' },
      p4: { uid: 'p4', name: 'Old', owner: 'boss', list: [{ uid: 'r4', name: 'Legacy', content: { price: 1 } }] }
    },
    planner: { o1: { uid: 'o1', name: 'Offer' } },
    budgets: {
      p1: [
        {
          uid: 'r1',
          name: 'Room',
          content: { price: 10 },
          subRows: [{ uid: 'r1b', name: 'Sub', content: { price: 5, reports: { '2026-09-02': [T1, OTHER_COPY] } } }]
        },
        { uid: 'r2', name: 'Food', content: { price: 3 } }
      ],
      p2: [{ uid: 'r9', name: 'Secret', content: { price: 1 } }],
      p3: [{ uid: 'r3', name: 'Stage', content: { price: 7 } }]
    }
  }
  result.fw.firestore[WS] = { serviceTickets: { s1: { title: 'Printer', account: 'a1' } } }
  return result
}

type Row = { uid: string; content?: { reports?: Record<string, Array<{ uid: string }>> }; subRows?: Row[] }

function budget(fw: Awaited<ReturnType<typeof setup>>['fw'], project: string): Row[] {
  return (fw.rtdb[WS]?.budgets as Record<string, Row[]> | undefined)?.[project] ?? []
}

function rowOf(rows: Row[], uid: string): Row | undefined {
  for (const row of rows) {
    if (row.uid === uid) return row
    const found = rowOf(row.subRows ?? [], uid)
    if (found) return found
  }
  return undefined
}

function copies(rows: Row[], key: string): Array<{ row: string; date: string; item: Record<string, unknown> }> {
  const found: Array<{ row: string; date: string; item: Record<string, unknown> }> = []
  const visit = (row: Row) => {
    for (const [date, items] of Object.entries(row.content?.reports ?? {})) {
      for (const item of items) if (item.uid === key) found.push({ row: row.uid, date, item })
    }
    for (const child of row.subRows ?? []) visit(child)
  }
  for (const row of rows) visit(row)
  return found
}

function timesheet(fw: Awaited<ReturnType<typeof setup>>['fw']) {
  return fw.rtdb[WS]?.timesheet as Record<string, Record<string, unknown>>
}

const writes = (world: Parameters<typeof rtdbRequests>[0]) =>
  rtdbRequests(world).filter((request) => request.method !== 'GET')

const writtenPaths = (world: Parameters<typeof rtdbRequests>[0]) =>
  writes(world).map((request) => `${request.method} ${request.url.pathname.replace(`/workspaces/${WS}/`, '')}`)

async function refusedBySchema(h: Harness, name: string, args: Record<string, unknown>) {
  const result = await h.client.callTool({ name, arguments: { workspace: WS, ...args } })
  return { isError: result.isError === true, text: (result.content as Array<{ text: string }>)[0]?.text ?? '' }
}

function add(h: Harness, args: Record<string, unknown>) {
  return h.call(ADD, { workspace: WS, ...args })
}

function update(h: Harness, args: Record<string, unknown>) {
  return h.call(UPDATE, { workspace: WS, ...args })
}

describe('campaigns_add_timesheet_report', () => {
  it('adds an entry without entity: one create-if-absent PUT, owner from the token, hours/minutes default 0', async () => {
    const { h, fw, world } = await setup()
    const result = await add(h, { date: '2026-10-01', hours: 1, project: 'p3', account: 'a1', tag: 'g1' })

    expect(result.isError).toBe(false)
    const key = result.body.key as string
    expect(key).toMatch(/^[-0-9A-Za-z_]{20}$/)
    expect(timesheet(fw)[key]).toEqual({
      date: '2026-10-01',
      hours: 1,
      minutes: 0,
      project: 'p3',
      account: 'a1',
      tag: 'g1',
      uid: key,
      owner: ME
    })
    expect(writtenPaths(world)).toEqual([`PUT timesheet/${key}.json`])
    expect(writes(world)[0]?.headers['if-match']).toBe(NULL_ETAG)
    expect(result.body).toMatchObject({ key, copy: null, written: [{ method: 'PUT', path: `timesheet/${key}` }] })
    expect(result.body.retries).toBe(0)
  })

  it('adds an entry with entity and its copy in reports[date] of that row, equal to the entry (AC-P4)', async () => {
    const { h, fw, world } = await setup({ allowPersonalData: true })
    const result = await add(h, {
      date: '2026-09-02',
      hours: 1,
      minutes: 15,
      project: 'p1',
      entity: 'r1b',
      account: 'a1',
      description: 'setup'
    })

    expect(result.isError).toBe(false)
    const key = result.body.key as string
    const entry = timesheet(fw)[key]
    expect(entry).toMatchObject({ owner: ME, uid: key, entity: 'r1b', description: 'setup' })
    const sub = rowOf(budget(fw, 'p1'), 'r1b')
    expect(sub?.content?.reports?.['2026-09-02']).toEqual([T1, OTHER_COPY, entry])
    expect(rowOf(budget(fw, 'p1'), 'r2')).toEqual({ uid: 'r2', name: 'Food', content: { price: 3 } })
    expect(writtenPaths(world)).toEqual([`PUT timesheet/${key}.json`, 'PUT budgets/p1.json'])
    expect(result.body).toMatchObject({
      copy: { budget: 'budgets/p1', row: 'r1b', date: '2026-09-02' },
      written: [
        { method: 'PUT', path: `timesheet/${key}` },
        { method: 'PUT', path: 'budgets/p1' }
      ]
    })
  })

  it('writes owner from the token uid in the entry and the copy; owner and updatedBy inputs are refused (F1, E29)', async () => {
    const { h, fw, world } = await setup()
    const ok = await add(h, { date: '2026-09-02', project: 'p1', entity: 'r2' })
    const key = ok.body.key as string
    expect(timesheet(fw)[key]?.owner).toBe(ME)
    expect(copies(budget(fw, 'p1'), key).map(({ item }) => item.owner)).toEqual([ME])

    const before = rtdbRequests(world).length
    for (const field of ['owner', 'updatedBy', 'uid', 'createdAt']) {
      const refused = await refusedBySchema(h, ADD, { date: '2026-09-02', project: 'p1', [field]: 'id-someone-else' })
      expect(refused.isError).toBe(true)
      expect(refused.text).toContain(`"${field}" cannot be set. The MCP sets it from your login.`)
    }
    expect(rtdbRequests(world).length).toBe(before)
  })

  it('a legacy project reads projects/<id>.list and writes the list with the copy to budgets/<id> only (P27)', async () => {
    const { h, fw, world } = await setup()
    const result = await add(h, { date: '2026-09-05', hours: 2, project: 'p4', entity: 'r4' })

    expect(result.isError).toBe(false)
    const key = result.body.key as string
    expect(copies(budget(fw, 'p4'), key)).toEqual([
      { row: 'r4', date: '2026-09-05', item: timesheet(fw)[key] as Record<string, unknown> }
    ])
    expect(budget(fw, 'p4')[0]).toMatchObject({ uid: 'r4', name: 'Legacy', content: { price: 1 } })
    expect((fw.rtdb[WS]?.projects as Record<string, unknown> | undefined)?.p4).toEqual({
      uid: 'p4',
      name: 'Old',
      owner: 'boss',
      list: [{ uid: 'r4', name: 'Legacy', content: { price: 1 } }]
    })
    const budgetPut = writes(world).find((request) => request.url.pathname.endsWith('/budgets/p4.json'))
    expect(budgetPut?.headers['if-match']).toBe(NULL_ETAG)
    expect(writes(world).some((request) => request.url.pathname.includes('/projects/'))).toBe(false)
  })

  it('a service-ticket entry needs the Firestore ticket and gets no budget copy (P20, P26)', async () => {
    const { h, fw, world } = await setup()
    const result = await add(h, { date: '2026-09-06', hours: 1, project: 's1', account: 'a1' })

    expect(result.isError).toBe(false)
    const key = result.body.key as string
    expect(timesheet(fw)[key]).toMatchObject({ project: 's1', owner: ME, uid: key })
    expect(writtenPaths(world)).toEqual([`PUT timesheet/${key}.json`])
    expect(firestoreRequests(world).map((request) => request.url.pathname)).toEqual([
      `/v1/projects/fake-campaigns/databases/(default)/documents/workspaces/${WS}/serviceTickets/s1`
    ])
    expect(result.body.copy).toBeNull()
  })

  it('refuses entity on a service ticket before any write (P26)', async () => {
    const { h, world } = await setup()
    const result = await add(h, { date: '2026-09-06', project: 's1', entity: 'r1' })

    expect(result.isError).toBe(true)
    expect(result.body.error).toContain('service ticket s1')
    expect(writes(world)).toEqual([])
  })

  it('refuses a missing project, a planner key and a missing entity row with E21, before any write', async () => {
    const { h, world } = await setup()
    const missing = await add(h, { date: '2026-09-06', project: 'nope' })
    const planner = await add(h, { date: '2026-09-06', project: 'o1' })
    const noRow = await add(h, { date: '2026-09-06', project: 'p1', entity: 'r-missing' })

    expect(missing.body.error).toBe(`Project "nope" does not exist in workspace ${WS}. Nothing was written.`)
    expect(planner.body.error).toBe(`Project "o1" does not exist in workspace ${WS}. Nothing was written.`)
    expect(noRow.body.error).toBe(`Budget row "r-missing" does not exist in workspace ${WS}. Nothing was written.`)
    expect(writes(world)).toEqual([])
  })

  it('refuses a hidden project with E18 before any write (F25, AC-P7)', async () => {
    const { h, world } = await setup()
    const result = await add(h, { date: '2026-09-06', project: 'p2', entity: 'r9' })

    expect(result.body.error).toBe('Project p2 is not found or is hidden from you. Nothing was written.')
    expect(writes(world)).toEqual([])
  })

  it('refuses without timesheet/me:manage (E17): no RTDB request at all (AC-P7)', async () => {
    const { h, world } = await setup({ permissions: ['campaigns_app:view', 'campaigns_app/timesheet/me:view'] })
    const result = await add(h, { date: '2026-09-06', project: 'p1' })

    expect(result.body.error).toBe(
      `You lack campaigns_app/timesheet/me:manage in workspace ${WS}, so ${ADD} cannot write.`
    )
    expect(rtdbRequests(world)).toEqual([])
  })

  it('refuses a future or malformed date (E22) with no Firebase request', async () => {
    const { h, world } = await setup()
    const future = await add(h, { date: '2027-02-01', project: 'p1' })
    const malformed = await add(h, { date: '2026-13-01', project: 'p1' })

    expect(future.body.error).toBe('date 2027-02-01 is in the future.')
    expect(malformed.body.error).toBe('date must be yyyy-MM-dd.')
    expect(world.requests.filter((request) => request.url.host === DB_HOST)).toEqual([])
  })

  it('refuses description while COLADA_ALLOW_PERSONAL_DATA is off (E20, AC-P10)', async () => {
    const { h, world } = await setup()
    const result = await add(h, { date: '2026-09-06', project: 'p1', description: 'call with Anna' })

    expect(result.body.error).toBe(
      '"description" is personal data. Writing it needs COLADA_ALLOW_PERSONAL_DATA=true. Nothing was written.'
    )
    expect(rtdbRequests(world)).toEqual([])
  })

  it('a budget changed by another user between read and write is re-applied and keeps that change (AC-P6)', async () => {
    const { h, fw } = await setup()
    let changed = false
    fw.beforeWrite = (method, path) => {
      if (changed || method !== 'PUT' || !path.endsWith('budgets/p1')) return
      changed = true
      const rows = budget(fw, 'p1') as Array<Row & { name: string }>
      rows[1] = { ...(rows[1] as Row & { name: string }), name: 'Food (renamed)' }
    }
    const result = await add(h, { date: '2026-09-07', hours: 1, project: 'p1', entity: 'r2' })

    expect(result.isError).toBe(false)
    expect(result.body.retries).toBe(1)
    expect(rowOf(budget(fw, 'p1'), 'r2')).toMatchObject({ name: 'Food (renamed)' })
    expect(copies(budget(fw, 'p1'), result.body.key as string)).toHaveLength(1)
  })

  it('a copy that hits four 412s is reported as a partial write (E23): entry saved, budget without copy', async () => {
    const { h, fw, world } = await setup()
    let price = 100
    fw.beforeWrite = (method, path) => {
      if (method !== 'PUT' || !path.endsWith('budgets/p1')) return
      const rows = budget(fw, 'p1') as Array<Row & { content: { price: number } }>
      rows[1] = { ...(rows[1] as Row & { content: { price: number } }), content: { price: price++ } }
    }
    const result = await add(h, { date: '2026-09-07', hours: 1, project: 'p1', entity: 'r2' })

    expect(result.isError).toBe(true)
    const key = Object.keys(timesheet(fw)).find((id) => !['t1', 't2', 't3', 't4'].includes(id)) as string
    expect(result.body.error).toContain(
      `${ADD} stopped after a partial write. Saved: timesheet/${key}. Not saved: budgets/p1.`
    )
    expect(result.body.error).toContain(`budgets/p1 has no copy`)
    expect(writtenPaths(world)).toEqual([
      `PUT timesheet/${key}.json`,
      'PUT budgets/p1.json',
      'PUT budgets/p1.json',
      'PUT budgets/p1.json',
      'PUT budgets/p1.json'
    ])
  })

  it('logs one line per write with no description, value or token (AC-P11)', async () => {
    const { h } = await setup({ allowPersonalData: true })
    const result = await add(h, { date: '2026-09-07', project: 'p1', entity: 'r2', description: 'secret words' })
    const key = result.body.key as string

    const lines = h.logs.filter((line) => line.tool === ADD) as unknown as Array<Record<string, unknown>>
    expect(lines.map((line) => [line.method, line.path, line.ifMatch, line.retries, line.httpStatus])).toEqual([
      ['PUT', `timesheet/${key}`, true, 0, 200],
      ['PUT', 'budgets/p1', true, 0, 200]
    ])
    const text = JSON.stringify(lines)
    expect(text).not.toContain('secret words')
    expect(text).not.toContain('auth=')
    expect(text).not.toContain('eyJ')
  })

  it('a refusal before any write logs the planned PUT with httpStatus null', async () => {
    const { h } = await setup()
    await add(h, { date: '2027-02-01', project: 'p1' })

    const [line] = h.logs.filter((entry) => entry.tool === ADD) as unknown as Array<Record<string, unknown>>
    expect(line).toMatchObject({ method: 'PUT', store: 'rtdb', httpStatus: null })
    expect(String(line?.path)).toMatch(/^timesheet\/[-0-9A-Za-z_]{20}$/)
  })

  it('does not show the description in the output while the flag is off', async () => {
    const { h, fw } = await setup()
    timesheet(fw).t4 = { ...timesheet(fw).t4, description: 'private note' }
    const result = await update(h, { key: 't4', hours: 2 })

    expect(result.isError).toBe(false)
    expect(result.body.entry).not.toHaveProperty('description')
    expect(timesheet(fw).t4?.description).toBe('private note')
    expect(copies(budget(fw, 'p1'), 't4')[0]?.item.description).toBe('private note')
  })
})

describe('campaigns_update_timesheet_report', () => {
  it('refuses a foreign entry (E19) and a missing entry (E21) before any write (AC-P7)', async () => {
    const { h, world } = await setup()
    const foreign = await update(h, { key: 't3', hours: 1 })
    const missing = await update(h, { key: 'nope', hours: 1 })

    expect(foreign.body.error).toBe(
      'Timesheet entry t3 is not yours. Only your own entries can be changed. Nothing was written.'
    )
    expect(missing.body.error).toBe(`Timesheet entry "nope" does not exist in workspace ${WS}. Nothing was written.`)
    expect(writes(world)).toEqual([])
  })

  it('a refusal after reads logs httpStatus null, not the status of the last read (AC-P11)', async () => {
    const { h } = await setup()
    await update(h, { key: 't3', hours: 1 })

    const lines = h.logs.filter((entry) => entry.tool === UPDATE) as unknown as Array<Record<string, unknown>>
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ method: 'PUT', path: 'timesheet/t3', httpStatus: null })
  })

  it('needs at least one field besides key', async () => {
    const { h, world } = await setup()
    const result = await update(h, { key: 't1' })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('at least one field')
    expect(rtdbRequests(world)).toEqual([])
  })

  it('keeps owner = token uid and refuses owner / updatedBy input (F1, E29)', async () => {
    const { h, fw, world } = await setup()
    for (const field of ['owner', 'updatedBy']) {
      const refused = await refusedBySchema(h, UPDATE, { key: 't1', hours: 1, [field]: 'id-someone-else' })
      expect(refused.text).toContain(`"${field}" cannot be set. The MCP sets it from your login.`)
    }
    expect(rtdbRequests(world)).toEqual([])

    const ok = await update(h, { key: 't1', hours: 4 })
    expect(ok.isError).toBe(false)
    expect(timesheet(fw).t1?.owner).toBe(ME)
    expect(copies(budget(fw, 'p1'), 't1').map(({ item }) => item.owner)).toEqual([ME])
  })

  it('an in-place change replaces the copy at its place by uid, one budget PUT (AC-P5)', async () => {
    const { h, fw, world } = await setup()
    const result = await update(h, { key: 't1', hours: 5, tag: 'g2' })

    expect(result.isError).toBe(false)
    expect(timesheet(fw).t1).toEqual({ ...T1, hours: 5, tag: 'g2' })
    expect(rowOf(budget(fw, 'p1'), 'r1b')?.content?.reports?.['2026-09-02']).toEqual([
      { ...T1, hours: 5, tag: 'g2' },
      OTHER_COPY
    ])
    expect(writtenPaths(world)).toEqual(['PUT timesheet/t1.json', 'PUT budgets/p1.json'])
    expect(result.body.copy).toEqual({
      mode: 'in-place',
      from: { budget: 'budgets/p1', row: 'r1b', date: '2026-09-02' },
      to: { budget: 'budgets/p1', row: 'r1b', date: '2026-09-02' }
    })
  })

  it('an in-place change adds a missing copy (repair after E23)', async () => {
    const { h, fw } = await setup()
    const result = await update(h, { key: 't4', minutes: 20 })

    expect(result.isError).toBe(false)
    expect(copies(budget(fw, 'p1'), 't4')).toEqual([{ row: 'r2', date: '2026-09-04', item: { ...timesheet(fw).t4 } }])
  })

  it('a move to another project adds to the new budget first, then removes from the old one (AC-P5, P25)', async () => {
    const { h, fw, world } = await setup()
    const result = await update(h, { key: 't1', project: 'p3', entity: 'r3' })

    expect(result.isError).toBe(false)
    expect(copies(budget(fw, 'p1'), 't1')).toEqual([])
    expect(rowOf(budget(fw, 'p1'), 'r1b')?.content?.reports?.['2026-09-02']).toEqual([OTHER_COPY])
    expect(copies(budget(fw, 'p3'), 't1')).toEqual([
      { row: 'r3', date: '2026-09-02', item: { ...T1, project: 'p3', entity: 'r3' } }
    ])
    expect(writtenPaths(world)).toEqual(['PUT timesheet/t1.json', 'PUT budgets/p3.json', 'PUT budgets/p1.json'])
    expect(result.body.copy).toEqual({
      mode: 'move',
      from: { budget: 'budgets/p1', row: 'r1b', date: '2026-09-02' },
      to: { budget: 'budgets/p3', row: 'r3', date: '2026-09-02' }
    })
  })

  it('a project change without entity clears entity and removes the old copy (P25)', async () => {
    const { h, fw, world } = await setup()
    const result = await update(h, { key: 't1', project: 'p3' })

    expect(result.isError).toBe(false)
    expect(timesheet(fw).t1).toEqual({ ...T1, project: 'p3', entity: '' })
    expect(copies(budget(fw, 'p1'), 't1')).toEqual([])
    expect(copies(budget(fw, 'p3'), 't1')).toEqual([])
    expect(writtenPaths(world)).toEqual(['PUT timesheet/t1.json', 'PUT budgets/p1.json'])
    expect(result.body.copy).toMatchObject({ mode: 'move', to: null })
  })

  it('a move to another row of the same project is one budget PUT: old row 0 copies, new row 1', async () => {
    const { h, fw, world } = await setup()
    const result = await update(h, { key: 't1', entity: 'r2' })

    expect(result.isError).toBe(false)
    expect(copies(budget(fw, 'p1'), 't1')).toEqual([{ row: 'r2', date: '2026-09-02', item: { ...T1, entity: 'r2' } }])
    expect(writtenPaths(world)).toEqual(['PUT timesheet/t1.json', 'PUT budgets/p1.json'])
  })

  it('a date change moves the copy between reports dates of the same row', async () => {
    const { h, fw } = await setup()
    const result = await update(h, { key: 't1', date: '2026-09-01' })

    expect(result.isError).toBe(false)
    const reports = rowOf(budget(fw, 'p1'), 'r1b')?.content?.reports
    expect(reports?.['2026-09-02']).toEqual([OTHER_COPY])
    expect(reports?.['2026-09-01']).toEqual([{ ...T1, date: '2026-09-01' }])
  })

  it('a removal that empties reports[date] drops that date key (M6)', async () => {
    const { h, fw } = await setup()
    await update(h, { key: 't4', minutes: 5 })
    const moved = await update(h, { key: 't4', date: '2026-09-01' })

    expect(moved.isError).toBe(false)
    expect(rowOf(budget(fw, 'p1'), 'r2')?.content?.reports).toEqual({
      '2026-09-01': [{ ...timesheet(fw).t4 }]
    })
  })

  it('a move from a service ticket to a project adds the copy only', async () => {
    const { h, fw, world } = await setup()
    const result = await update(h, { key: 't2', project: 'p3', entity: 'r3' })

    expect(result.isError).toBe(false)
    expect(copies(budget(fw, 'p3'), 't2')).toHaveLength(1)
    expect(writtenPaths(world)).toEqual(['PUT timesheet/t2.json', 'PUT budgets/p3.json'])
    expect(result.body.copy).toMatchObject({ mode: 'move', from: null })
  })

  it('refuses a move to a hidden project (E18) or a missing row (E21) before any write', async () => {
    const { h, world } = await setup()
    const hidden = await update(h, { key: 't1', project: 'p2', entity: 'r9' })
    const noRow = await update(h, { key: 't1', entity: 'r-missing' })

    expect(hidden.body.error).toBe('Project p2 is not found or is hidden from you. Nothing was written.')
    expect(noRow.body.error).toBe(`Budget row "r-missing" does not exist in workspace ${WS}. Nothing was written.`)
    expect(writes(world)).toEqual([])
  })

  it('refuses description while the flag is off (E20, AC-P10)', async () => {
    const { h, world } = await setup()
    const result = await update(h, { key: 't1', description: 'new text' })

    expect(result.body.error).toContain('"description" is personal data.')
    expect(rtdbRequests(world)).toEqual([])
  })

  it('a removal that hits four 412s names both budgets and writes nothing more (AC-P5)', async () => {
    const { h, fw, world } = await setup()
    let price = 100
    fw.beforeWrite = (method, path) => {
      if (method !== 'PUT' || !path.endsWith('budgets/p1')) return
      const rows = budget(fw, 'p1') as Array<Row & { content: { price: number } }>
      rows[1] = { ...(rows[1] as Row & { content: { price: number } }), content: { price: price++ } }
    }
    const result = await update(h, { key: 't1', project: 'p3', entity: 'r3' })

    expect(result.isError).toBe(true)
    expect(result.body.error).toContain(
      `${UPDATE} stopped after a partial write. Saved: timesheet/t1, budgets/p3. Not saved: budgets/p1.`
    )
    expect(result.body.error).toContain('The copy is in both budgets/p3 and budgets/p1.')
    expect(writtenPaths(world)).toEqual([
      'PUT timesheet/t1.json',
      'PUT budgets/p3.json',
      'PUT budgets/p1.json',
      'PUT budgets/p1.json',
      'PUT budgets/p1.json',
      'PUT budgets/p1.json'
    ])
    expect(copies(budget(fw, 'p3'), 't1')).toHaveLength(1)
    expect(copies(budget(fw, 'p1'), 't1')).toHaveLength(1)
  })

  it('an add to the new budget that fails leaves the copy in the old budget only (E23)', async () => {
    const { h, fw } = await setup()
    let price = 100
    fw.beforeWrite = (method, path) => {
      if (method !== 'PUT' || !path.endsWith('budgets/p3')) return
      const rows = budget(fw, 'p3') as Array<Row & { content: { price: number } }>
      rows[0] = { ...(rows[0] as Row & { content: { price: number } }), content: { price: price++ } }
    }
    const result = await update(h, { key: 't1', project: 'p3', entity: 'r3' })

    expect(result.body.error).toContain('Saved: timesheet/t1. Not saved: budgets/p3, budgets/p1.')
    expect(result.body.error).toContain('The copy is still only in budgets/p1.')
    expect(copies(budget(fw, 'p1'), 't1')).toHaveLength(1)
  })
})

describe('write paths are checked before any request (point 3 of Gate 1)', () => {
  it('a planned path outside the table is refused before the Firebase mint and before any read', async () => {
    const { h, world } = await setup()
    const result = await runFirebaseWriteTool(
      h.app,
      ADD,
      undefined,
      {
        app: 'campaigns',
        store: 'rtdb',
        method: 'PUT',
        path: 'projects/p1',
        paths: null,
        ifMatch: true,
        retries: 0
      },
      async (ctx) => {
        await openWriter(h.app, ctx, ADD, { workspace: WS }, [{ method: 'PUT', path: 'projects/p1' }])
        return {}
      }
    )

    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain(
      `PUT workspaces/${WS}/projects/p1 is not allowed for ${ADD}`
    )
    expect(world.requests.filter((request) => request.url.host === DB_HOST)).toEqual([])
    expect(world.requests.some((request) => request.url.host === 'identitytoolkit.googleapis.com')).toBe(false)
  })
})
