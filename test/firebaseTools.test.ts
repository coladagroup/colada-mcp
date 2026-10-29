import { afterEach, describe, expect, it } from 'vitest'
import { isoWeek } from '../src/firebase/localOps.js'
import {
  API_KEY,
  DB_HOST,
  FIRESTORE_HOST,
  firebaseSetup,
  firestoreRequests,
  IDENTITY_HOST,
  ME,
  rtdbRequests
} from './firebaseFake.js'
import { type Harness, WS_A, WS_B } from './harness.js'

const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

async function setup(options: { allowPersonalData?: boolean } = {}) {
  const result = await firebaseSetup(options)
  harnesses.push(result.h)
  result.fw.rtdb[WS_A] = {
    timesheet: {
      t1: { owner: ME, date: '2026-09-02', hours: 2, minutes: 30, project: 'p1', description: 'met John' },
      t2: { owner: ME, date: '2026-09-20', hours: '1', minutes: 15, project: 'p1', description: 'call' },
      t3: { owner: 'other', date: '2026-10-01', hours: 3, minutes: 0, project: 'p2', description: 'x' },
      t4: { owner: 'other', date: '2026-10-05', hours: 1, minutes: 45, project: 'p3', description: 'y' }
    },
    projects: {
      p1: { name: 'Fair', number: '1', owner: 'boss', deputies: [ME], contact: 'c1', total: 100, isPrivate: false },
      p2: { name: 'Hidden', number: '2', owner: 'boss', isPrivate: 'true' },
      p3: { name: 'Gala', number: '3', owner: 'boss' }
    },
    planner: { o1: { name: 'Offer', notes: 'call Anna', person: 'c2' } },
    budgets: { p1: [{ uid: 'r1', name: 'Room', content: { price: 10 } }], p2: [{ uid: 'r2', name: 'X' }] },
    tags: { g1: { name: 'Billable' } },
    companyDetails: { name: 'Co', dropboxSignApiKey: 'SECRETKEY', skribbleApiKeyLast4: '1234' },
    secrets: { dropboxSignApiKey: 'SECRETKEY' }
  }
  result.fw.rtdb[WS_B] = { tags: { b1: { name: 'Other workspace' } } }
  return result
}

function rtdb(h: Harness, args: Record<string, unknown>) {
  return h.call('rtdb_get', { workspace: WS_A, app: 'campaigns', ...args })
}

function firestore(h: Harness, args: Record<string, unknown>) {
  return h.call('firestore_get', { workspace: WS_A, app: 'campaigns', ...args })
}

describe('rtdb_get', () => {
  it('reads a node of the requested workspace with ?auth=, no Authorization header, and sorted keys', async () => {
    const { h, world } = await setup()
    const result = await rtdb(h, { path: 'tags' })

    expect(result.isError).toBe(false)
    expect(result.body).toMatchObject({
      workspace: { id: WS_A },
      app: 'campaigns',
      store: 'rtdb',
      path: 'tags',
      count: 1,
      data: { g1: { name: 'Billable' } },
      removedFields: []
    })
    const request = rtdbRequests(world).at(-1)
    expect(request?.url.pathname).toBe(`/workspaces/${WS_A}/tags.json`)
    expect(request?.headers.authorization).toBeUndefined()
    expect(request?.method).toBe('GET')
    expect(request?.redirect).toBe('error')
  })

  it('AC-F8: the path cannot leave the workspace', async () => {
    const { h, world } = await setup()
    for (const path of [`../${WS_B}/tags`, '/tags', 'tags%2f..', '']) {
      const result = await rtdb(h, { path })
      expect(result.isError, path).toBe(true)
      expect(result.body.error).toMatch(/is not allowed/)
    }
    expect(rtdbRequests(world)).toHaveLength(0)
  })

  it('AC-F9: secrets, the workspace root and unknown nodes are refused before any Firebase request', async () => {
    const { h, world } = await setup({ allowPersonalData: true })
    for (const path of ['secrets', 'secrets/dropboxSignApiKey', 'users', 'mail']) {
      expect((await rtdb(h, { path })).body.error, path).toMatch(/not on the rtdb allowlist/)
    }
    expect(rtdbRequests(world)).toHaveLength(0)
  })

  it('AC-F10: a missing node permission is refused before any RTDB request', async () => {
    const { h, fw, world } = await setup()
    fw.permissions = ['campaigns_app:view']
    const result = await rtdb(h, { path: 'budgets/p1' })
    expect(result.body.error).toBe(
      `You lack campaigns_app/projects/budget:view in workspace ${WS_A}, so budgets cannot be read.`
    )
    expect(rtdbRequests(world)).toHaveLength(0)
  })

  it('AC-F14, AC-F16: personal fields are removed and listed by name only', async () => {
    const { h } = await setup()
    const result = await rtdb(h, { path: 'projects' })
    expect(result.body.data).toEqual({
      p1: { name: 'Fair', number: '1', total: 100, isPrivate: false },
      p3: { name: 'Gala', number: '3' }
    })
    expect(result.body.removedFields).toEqual(['contact', 'deputies', 'owner'])
    expect(result.text).not.toContain('boss')
  })

  it('AC-F14: with personal data on, the personal fields come back', async () => {
    const { h } = await setup({ allowPersonalData: true })
    const result = await rtdb(h, { path: 'timesheet/t1' })
    expect(result.body.data).toMatchObject({ description: 'met John' })
    expect(result.body.removedFields).toEqual([])
  })

  it('AC-F14: personal nodes are refused while personal data is off', async () => {
    const { h } = await setup()
    expect((await rtdb(h, { path: 'accounts' })).body.error).toBe(
      'accounts holds personal data. It is off; COLADA_ALLOW_PERSONAL_DATA=true turns it on.'
    )
  })

  it('AC-F15: secret fields of companyDetails are removed also with personal data on', async () => {
    const { h, fw } = await setup({ allowPersonalData: true })
    fw.permissions.push('campaigns_app/administration/companyDetails:view')
    const result = await rtdb(h, { path: 'companyDetails' })
    expect(result.body.data).toEqual({ name: 'Co', skribbleApiKeyLast4: '1234' })
    expect(result.body.removedFields).toEqual(['dropboxSignApiKey'])
    expect(result.text).not.toContain('SECRETKEY')
  })

  it('AC-F12: hidden projects are removed from lists and refused by id; their budget is "not found"', async () => {
    const { h, fw } = await setup()
    fw.permissions.push('campaigns_app/projects/budget:view')
    const list = await rtdb(h, { path: 'projects' })
    expect(Object.keys(list.body.data as object)).toEqual(['p1', 'p3'])
    expect(list.body.removedRecords).toBe(1)
    expect(list.text).not.toContain('Hidden')

    expect((await rtdb(h, { path: 'projects/p2' })).body.error).toBe('Nothing found at rtdb projects/p2.')
    expect((await rtdb(h, { path: 'budgets/p2' })).body.error).toBe('Nothing found at rtdb budgets/p2.')
    expect((await rtdb(h, { path: 'budgets/p1' })).body.data).toEqual([
      { uid: 'r1', name: 'Room', content: { price: 10 } }
    ])
  })

  it('AC-F12: timesheet rows booked on a hidden project are removed, also from groupBy totals', async () => {
    const { h } = await setup()
    const rows = await rtdb(h, { path: 'timesheet' })
    expect(Object.keys(rows.body.data as object)).toEqual(['t1', 't2', 't4'])
    expect(rows.body.removedRecords).toBe(1)
    const grouped = await rtdb(h, { path: 'timesheet', groupBy: ['project'], sum: ['hours'] })
    expect(grouped.body.total).toEqual({ count: 3, sums: { hours: 4 } })
  })

  it('AC-F12: a lobby user sees only projects where they are deputy, requester or account manager', async () => {
    const { h, fw } = await setup()
    fw.roles = ['campaigns_app_requester']
    const list = await rtdb(h, { path: 'projects' })
    expect(Object.keys(list.body.data as object)).toEqual(['p1'])
  })

  it('AC-F11: with only own-timesheet access, the MCP filters by owner in Firebase and again locally', async () => {
    const { h, fw, world } = await setup()
    fw.permissions = ['campaigns_app:view', 'campaigns_app/timesheet/me:view']
    const result = await rtdb(h, { path: 'timesheet', groupBy: ['owner'], sum: ['hours', 'minutes'] })

    expect(result.body.groups).toEqual([{ key: { owner: ME }, count: 2, sums: { hours: 3, minutes: 45 } }])
    const request = rtdbRequests(world).at(-1)
    expect(request?.url.searchParams.get('orderBy')).toBe('"owner"')
    expect(request?.url.searchParams.get('equalTo')).toBe(`"${ME}"`)

    expect((await rtdb(h, { path: 'timesheet/t3' })).body.error).toBe('Nothing found at rtdb timesheet/t3.')
    expect((await rtdb(h, { path: 'timesheet', orderBy: 'project', equalTo: 'p1' })).body.error).toContain(
      'With only "own timesheet" access'
    )
  })

  it('AC-F20: groupBy with date buckets and sum, numeric strings count as numbers', async () => {
    const { h } = await setup()
    const result = await rtdb(h, { path: 'timesheet', groupBy: ['owner', 'date:month'], sum: ['hours', 'minutes'] })
    expect(result.body).toMatchObject({
      groups: [
        { key: { owner: ME, 'date:month': '2026-09' }, count: 2, sums: { hours: 3, minutes: 45 } },
        { key: { owner: 'other', 'date:month': '2026-10' }, count: 1, sums: { hours: 1, minutes: 45 } }
      ],
      total: { count: 3, sums: { hours: 4, minutes: 90 } },
      removedRecords: 1
    })
    expect(result.body.data).toBeUndefined()
  })

  it('AC-F20: ISO week buckets at the year edge', () => {
    expect(isoWeek('2026-12-31')).toBe('2026-W53')
    expect(isoWeek('2027-01-01')).toBe('2026-W53')
    expect(isoWeek('2027-01-04')).toBe('2027-W01')
    expect(isoWeek('2026-01-01')).toBe('2026-W01')
    expect(isoWeek('not a date')).toBeNull()
  })

  it('where and fields run after the download', async () => {
    const { h } = await setup()
    const result = await rtdb(h, {
      path: 'timesheet',
      where: [
        { field: 'date', op: 'gte', value: '2026-09-10' },
        { field: 'project', op: 'in', value: ['p1', 'p3'] }
      ],
      fields: ['date', 'hours']
    })
    expect(result.body.data).toEqual({ t2: { date: '2026-09-20', hours: '1' }, t4: { date: '2026-10-05', hours: 1 } })
  })

  it('AC-F17: a removed field cannot be used in where / fields / groupBy / sum; nothing is sent', async () => {
    const { h, world } = await setup()
    for (const args of [
      { where: [{ field: 'description', op: 'exists' }] },
      { fields: ['description'] },
      { groupBy: ['description'] },
      { sum: ['description'] }
    ]) {
      const result = await rtdb(h, { path: 'timesheet', ...args })
      expect(result.body.error).toMatch(/"description" is personal data and is hidden/)
    }
    expect(rtdbRequests(world)).toHaveLength(0)
  })

  it('local options need a list of records', async () => {
    const { h } = await setup()
    expect((await rtdb(h, { path: 'projects/p1', fields: ['name'] })).body.error).toBe(
      '"fields" works on a list of records, but projects/p1 is one record.'
    )
  })

  it('query rules: values are JSON literals, shallow stays alone, filters need orderBy', async () => {
    const { h, world } = await setup()
    await rtdb(h, { path: 'projects', orderBy: 'archived', equalTo: false })
    expect(rtdbRequests(world).at(-1)?.url.searchParams.get('equalTo')).toBe('false')
    expect((await rtdb(h, { path: 'tags', equalTo: 'x' })).body.error).toBe(
      'The query options are not valid: equalTo need orderBy.'
    )
    expect((await rtdb(h, { path: 'tags', shallow: true, orderBy: '$key' })).body.error).toBe(
      'The query options are not valid: shallow cannot be combined with other options.'
    )
    expect((await rtdb(h, { path: 'tags', shallow: true, fields: ['name'] })).body.error).toContain(
      'shallow cannot be combined with where'
    )
    expect((await rtdb(h, { path: 'timesheet', shallow: true })).body.error).toBe(
      'shallow is not available for timesheet: its records are filtered by project. Use "fields" to get small records.'
    )
    expect((await rtdb(h, { path: 'tags', shallow: true })).body.data).toEqual({ g1: true })
  })

  it('an unindexed orderBy gets the index hint', async () => {
    const { h } = await setup()
    expect((await rtdb(h, { path: 'timesheet', orderBy: 'date', startAt: '2026-09-01' })).body.error).toBe(
      'RTDB has no index on "date" for timesheet. Use an indexed child ($key, owner, project) or "where" (filters after a full download).'
    )
  })

  it('a Firebase 401 mints a new ID token once and retries once', async () => {
    const { h, fw, world } = await setup()
    fw.rtdbStatus.push(401)
    expect((await rtdb(h, { path: 'tags' })).isError).toBe(false)
    expect(world.requests.filter((r) => r.url.host === IDENTITY_HOST)).toHaveLength(2)

    fw.rtdbStatus.push(401, 401)
    expect((await rtdb(h, { path: 'tags' })).body.error).toBe(
      'Firebase refused the read of tags (expired token or a rules violation).'
    )
  })

  it('AC-F18: a download over 10 MB is stopped with the narrowing hint', async () => {
    const { h, fw } = await setup()
    fw.rtdbRaw = (url) =>
      url.pathname.endsWith('/timesheet.json')
        ? new Response(JSON.stringify({ big: 'x'.repeat(10_000_100) }), {
            headers: { 'Content-Type': 'application/json' }
          })
        : undefined
    expect((await rtdb(h, { path: 'timesheet' })).body.error).toBe(
      'rtdb timesheet is larger than 10 MB. Narrow it with orderBy on an indexed child ($key, owner, project), limitToFirst / limitToLast, or shallow.'
    )
  })

  it('AC-F19: a result over 500 KB is not returned; groupBy makes it small', async () => {
    const { h, fw } = await setup()
    fw.rtdb[WS_A] = {
      tags: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`g${i}`, { name: 'n'.repeat(200), kind: 'a' }]))
    }
    expect((await rtdb(h, { path: 'tags' })).body.error).toBe(
      'The result is larger than 500 KB and is not returned. Use "fields", "where", "groupBy" or a narrower path.'
    )
    expect((await rtdb(h, { path: 'tags', groupBy: ['kind'] })).body.total).toEqual({ count: 3000, sums: {} })
  })
})

describe('firestore_get', () => {
  function seed(fw: Awaited<ReturnType<typeof setup>>['fw']) {
    fw.permissions.push('campaigns_app/serviceTickets:view', 'campaigns_app/offers:view')
    fw.firestore[WS_A] = {
      serviceTickets: {
        s1: {
          name: 'Broken lamp',
          number: 'T-1',
          description: 'Anna called',
          contact: 'c1',
          hours: 1.5,
          tags: [],
          meta: {}
        },
        s2: { name: 'Wifi', number: 'T-2', owner: ME, big: 2 ** 53 }
      },
      snapshots: {
        n1: { name: 'Offer v1', project: 'p1', pdf: 'https://storage/x' },
        n2: { name: 'Hidden', project: 'p2' }
      }
    }
  }

  it('lists a collection as plain JSON with Bearer auth, without personal fields', async () => {
    const { h, fw, world } = await setup()
    seed(fw)
    const result = await firestore(h, { path: 'serviceTickets', pageSize: 1 })

    expect(result.body).toMatchObject({
      store: 'firestore',
      path: 'serviceTickets',
      documents: [
        {
          id: 's1',
          updateTime: '2026-10-01T10:00:00Z',
          data: { name: 'Broken lamp', number: 'T-1', hours: 1.5, tags: [], meta: {} }
        }
      ],
      nextPageToken: '1',
      removedFields: ['contact', 'description']
    })
    const request = firestoreRequests(world).at(-1)
    expect(request?.url.pathname).toBe(
      `/v1/projects/fake-campaigns/databases/(default)/documents/workspaces/${WS_A}/serviceTickets`
    )
    expect(request?.headers.authorization).toMatch(/^Bearer /)
    expect(request?.url.searchParams.get('pageSize')).toBe('1')

    const next = await firestore(h, { path: 'serviceTickets', pageToken: '1' })
    expect(next.body.documents).toEqual([
      {
        id: 's2',
        updateTime: '2026-10-01T10:00:00Z',
        data: { name: 'Wifi', number: 'T-2', owner: ME, big: '9007199254740992' }
      }
    ])
  })

  it('reads one document and sends fields as mask.fieldPaths', async () => {
    const { h, fw, world } = await setup()
    seed(fw)
    const result = await firestore(h, { path: 'serviceTickets/s1', fields: ['name', 'number'] })
    expect(result.body).toMatchObject({ id: 's1', data: { name: 'Broken lamp', number: 'T-1' } })
    expect(firestoreRequests(world).at(-1)?.url.searchParams.getAll('mask.fieldPaths')).toEqual(['name', 'number'])
    expect((await firestore(h, { path: 'serviceTickets/s1', fields: ['description'] })).body.error).toMatch(
      /"description" is personal data/
    )
  })

  it('a missing document is "not found"; a hidden project snapshot too', async () => {
    const { h, fw } = await setup()
    seed(fw)
    expect((await firestore(h, { path: 'serviceTickets/nope' })).body.error).toBe(
      'Nothing found at firestore serviceTickets/nope.'
    )
    expect((await firestore(h, { path: 'snapshots/n2' })).body.error).toBe('Nothing found at firestore snapshots/n2.')
    const list = await firestore(h, { path: 'snapshots' })
    expect((list.body.documents as Array<{ id: string }>).map((d) => d.id)).toEqual(['n1'])
    expect(list.body.removedRecords).toBe(1)
    expect(list.body.removedFields).toEqual(['pdf'])
  })

  it('refuses subcollections, page options on a document and collections not on the allowlist', async () => {
    const { h, fw, world } = await setup({ allowPersonalData: true })
    seed(fw)
    expect((await firestore(h, { path: 'serviceTickets/s1/history' })).body.error).toContain(
      'only a collection or one document'
    )
    expect((await firestore(h, { path: 'serviceTickets/s1', pageSize: 5 })).body.error).toContain(
      'pageSize and pageToken'
    )
    for (const path of ['requests', 'contactInfos', 'mail', 'notification']) {
      expect((await firestore(h, { path })).body.error).toMatch(/not on the firestore allowlist/)
    }
    expect(firestoreRequests(world)).toHaveLength(0)
  })

  it('an empty collection gives an empty list', async () => {
    const { h, fw } = await setup()
    seed(fw)
    fw.firestore[WS_A] = { serviceTickets: {} }
    expect((await firestore(h, { path: 'serviceTickets' })).body.documents).toEqual([])
  })
})

describe('call log, tokens and methods (AC-F3, AC-F13, AC-F22)', () => {
  it('logs app, store, path and query options; where without values; never tokens or URLs', async () => {
    const { h, fw } = await setup()
    await rtdb(h, {
      path: 'timesheet',
      orderBy: 'project',
      equalTo: 'p1',
      where: [{ field: 'date', op: 'gte', value: '2026-09-10' }],
      groupBy: ['owner'],
      sum: ['hours']
    })
    const entry = h.logs.at(-1)
    expect(entry).toMatchObject({
      tool: 'rtdb_get',
      workspace: WS_A,
      app: 'campaigns',
      store: 'rtdb',
      path: 'timesheet',
      query: {
        orderBy: 'project',
        equalTo: 'p1',
        where: [{ field: 'date', op: 'gte' }],
        groupBy: ['owner'],
        sum: ['hours']
      },
      httpStatus: 200
    })
    const logged = JSON.stringify(h.logs)
    expect(logged).not.toContain('2026-09-10')
    for (const secret of [API_KEY, ...fw.idTokens, 'auth=', DB_HOST]) expect(logged).not.toContain(secret)
  })

  it('no tool result carries a Firebase token or the API key', async () => {
    const { h, fw } = await setup()
    const texts = [
      (await rtdb(h, { path: 'tags' })).text,
      (await rtdb(h, { path: 'timesheet', orderBy: 'date' })).text,
      (await firestore(h, { path: 'serviceTickets' })).text
    ].join('\n')
    for (const secret of [API_KEY, ...fw.idTokens]) expect(texts).not.toContain(secret)
  })

  it('every Firebase data request is a GET and no other Google host is called', async () => {
    const { h, fw, world } = await setup()
    fw.permissions.push('campaigns_app/serviceTickets:view')
    await rtdb(h, { path: 'timesheet' })
    await firestore(h, { path: 'serviceTickets' })
    const google = world.requests.filter((r) => r.url.host.endsWith('googleapis.com') || r.url.host === DB_HOST)
    expect(new Set(google.map((r) => r.url.host))).toEqual(new Set([IDENTITY_HOST, DB_HOST, FIRESTORE_HOST]))
    for (const r of google.filter((r) => r.url.host !== IDENTITY_HOST)) expect(r.method).toBe('GET')
  })
})

describe('campaigns_budget (F8, AC-F21)', () => {
  async function budgetSetup() {
    const result = await setup()
    result.fw.permissions.push('campaigns_app/projects/budget:view', 'campaigns_app/offers:view')
    const ws = result.fw.rtdb[WS_A] as Record<string, Record<string, unknown>>
    ws.budgets = {
      ...ws.budgets,
      p1: [
        {
          uid: 'g',
          name: 'Hall',
          content: { price: 0 },
          subRows: [
            {
              uid: 'r1',
              name: 'Room',
              content: {
                price: 100,
                selectedQuantity: 2,
                allocated: 150,
                reports: { '2026-09-01': [{ hours: 1, minutes: 30, description: 'met John', owner: ME }] },
                invoices: [{ amount: 40, supplier: 'Bob', notes: 'n', title: 't' }]
              }
            },
            { uid: 'f', name: 'Fee', content: { price: 0, effort: 'reserve', feeMode: 'linear', selectedQuantity: 10 } }
          ]
        },
        { uid: 'o', name: 'Extra', content: { price: 50, effort: 'option' } }
      ]
    }
    ws.projects = {
      ...ws.projects,
      p1: { ...(ws.projects?.p1 as object), currency: 'CHF', exchangeRates: '', total: 210 }
    }
    ws.planner = {
      o1: {
        name: 'Offer',
        number: 'O-1',
        notes: 'call Anna',
        list: [{ uid: 'x', name: 'Legacy', content: { price: 70 } }]
      }
    }
    ws.plannerBudgets = {}
    return result
  }

  it('returns totals and flat rows computed like the UI, without personal fields', async () => {
    const { h } = await budgetSetup()
    const result = await h.call('campaigns_budget', { workspace: WS_A, kind: 'projects', id: 'p1' })

    expect(result.isError).toBe(false)
    expect(result.body).toMatchObject({
      kind: 'projects',
      id: 'p1',
      name: 'Fair',
      number: '1',
      currency: 'CHF',
      total: 220,
      totalWithOptions: 270,
      allocated: 150,
      actual: 190,
      storedTotal: 210,
      removedFields: []
    })
    const rows = result.body.rows as Array<Record<string, unknown>>
    expect(rows.map((r) => [r.path, r.total])).toEqual([
      ['Hall', 220],
      ['Hall > Room', 200],
      ['Hall > Fee', 0],
      ['Extra', 0]
    ])
    expect(rows[2]?.reserveAmount).toBe(20)
    expect(result.text).not.toMatch(/met John|Bob|call Anna/)
  })

  it('reads an offer from plannerBudgets and falls back to the legacy list', async () => {
    const { h } = await budgetSetup()
    const result = await h.call('campaigns_budget', { workspace: WS_A, kind: 'planner', id: 'o1', rows: false })
    expect(result.body).toMatchObject({ kind: 'planner', name: 'Offer', total: 70 })
    expect(result.body.rows).toBeUndefined()
  })

  it('a hidden project or a missing one is "not found"; missing permissions are named', async () => {
    const { h } = await budgetSetup()
    expect((await h.call('campaigns_budget', { workspace: WS_A, kind: 'projects', id: 'p2' })).body.error).toBe(
      'Nothing found at rtdb projects/p2.'
    )
    expect((await h.call('campaigns_budget', { workspace: WS_A, kind: 'projects', id: 'nope' })).body.error).toBe(
      'Nothing found at rtdb projects/nope.'
    )
    expect((await h.call('campaigns_budget', { workspace: WS_A, kind: 'projects', id: '../x' })).body.error).toMatch(
      /is not allowed/
    )
  })

  it('a missing budget permission is named before any RTDB read', async () => {
    const { h, fw, world } = await budgetSetup()
    fw.permissions = ['campaigns_app:view']
    expect((await h.call('campaigns_budget', { workspace: WS_A, kind: 'projects', id: 'p1' })).body.error).toBe(
      `You lack campaigns_app/projects/budget:view in workspace ${WS_A}, so budgets cannot be read.`
    )
    expect(rtdbRequests(world)).toHaveLength(0)
  })

  it('logs kind/id as the path and no body', async () => {
    const { h } = await budgetSetup()
    await h.call('campaigns_budget', { workspace: WS_A, kind: 'projects', id: 'p1' })
    expect(h.logs.at(-1)).toMatchObject({ tool: 'campaigns_budget', store: 'rtdb', path: 'projects/p1', query: {} })
    expect(JSON.stringify(h.logs)).not.toContain('Hall')
  })
})

describe('Stage 6 review findings (STAGE6-REVIEW-phase4.md)', () => {
  async function reviewSetup(options: { allowPersonalData?: boolean } = {}) {
    const result = await setup(options)
    result.fw.permissions.push('campaigns_app/tasks:view', 'campaigns_app/offers:view', 'campaigns_app/leads:view')
    const ws = result.fw.rtdb[WS_A] as Record<string, Record<string, unknown>>
    ws.tasks = { k1: { name: 'Secret task', createdAt: 1, source: 'p2' } }
    ws.deals = { d1: { contact: { email: 'alice@example.com' }, chance: 50 } }
    result.fw.firestore[WS_A] = { snapshots: { n2: { name: 'Hidden snap', project: 'p2', total: 5 } } }
    return result
  }

  it('A: query options on a one-record read of a field-linked node cannot drop the link field', async () => {
    const { h } = await reviewSetup()
    for (const args of [
      { path: 'timesheet/t3', orderBy: '$key', endAt: 'hours' },
      { path: 'tasks/k1', orderBy: '$key', endAt: 'name' },
      { path: 'tasks/k1', orderBy: '$key', limitToFirst: 1 }
    ]) {
      const result = await rtdb(h, args)
      expect(result.isError, JSON.stringify(args)).toBe(true)
      expect(result.text).not.toContain('Secret task')
      expect(result.text).not.toContain('"hours":3')
    }
  })

  it('B: a Firestore fields mask cannot drop the snapshots project link', async () => {
    const { h } = await reviewSetup()
    expect((await firestore(h, { path: 'snapshots/n2', fields: ['name', 'total'] })).body.error).toBe(
      'Nothing found at firestore snapshots/n2.'
    )
    const list = await firestore(h, { path: 'snapshots', fields: ['name'] })
    expect(list.body.documents).toEqual([])
    expect(list.body.removedRecords).toBe(1)
  })

  it('B: link fields added to the mask are not returned when they were not asked for', async () => {
    const { h, fw } = await reviewSetup()
    ;(fw.firestore[WS_A] as Record<string, Record<string, unknown>>).snapshots = {
      n1: { name: 'Offer v1', project: 'p1' }
    }
    const result = await firestore(h, { path: 'snapshots/n1', fields: ['name'] })
    expect(result.body.data).toEqual({ name: 'Offer v1' })
  })

  it('C: campaigns_budget refuses an id with more than one segment', async () => {
    const { h } = await reviewSetup()
    for (const id of ['p2/snapshots/s1', 'p2/list/0', 'p1/']) {
      const result = await h.call('campaigns_budget', { workspace: WS_A, kind: 'projects', id })
      expect(result.body.error, id).toMatch(/is not allowed/)
    }
  })

  it('D: orderBy on a removed field is refused while personal data is off', async () => {
    const { h, world } = await reviewSetup()
    expect((await rtdb(h, { path: 'projects', orderBy: 'owner', equalTo: 'boss' })).body.error).toBe(
      '"owner" is personal data and is hidden, so it cannot be used in orderBy. COLADA_ALLOW_PERSONAL_DATA=true shows it.'
    )
    expect(rtdbRequests(world)).toHaveLength(0)
    expect((await rtdb(h, { path: 'timesheet', orderBy: 'owner', equalTo: ME })).isError).toBe(false)
  })

  it('D: with personal data on, orderBy owner works on projects', async () => {
    const { h } = await reviewSetup({ allowPersonalData: true })
    expect((await rtdb(h, { path: 'projects', orderBy: 'owner', equalTo: 'boss' })).isError).toBe(false)
  })

  it('E: a read that starts below a removed field returns nothing', async () => {
    const { h } = await reviewSetup()
    const result = await rtdb(h, { path: 'deals/d1/contact/email' })
    expect(result.text).not.toContain('alice@example.com')
    expect(result.body.data).toBeNull()
    expect(result.body.removedFields).toEqual(['contact'])
    const deputy = await rtdb(h, { path: 'projects/p1/deputies/0' })
    expect(deputy.text).not.toContain(ME)
    expect(deputy.body.removedFields).toEqual(['deputies'])
  })
})

describe('PR #13 code review findings', () => {
  function brokenStream() {
    let sent = false
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (!sent) {
            sent = true
            controller.enqueue(new TextEncoder().encode('{"p2":{"isPri'))
          } else controller.error(new Error('connection reset'))
        }
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  it('1: a body that breaks while reading fails closed, also on the internal projects read', async () => {
    const { h, fw } = await setup()
    fw.rtdbRaw = (url) => (url.pathname.endsWith('/projects.json') ? brokenStream() : undefined)
    const result = await rtdb(h, { path: 'timesheet' })
    expect(result.isError).toBe(true)
    expect(result.text).not.toContain('"t3"')
    fw.rtdbRaw = (url) => (url.pathname.endsWith('/tags.json') ? brokenStream() : undefined)
    expect((await rtdb(h, { path: 'tags' })).body.error).toBe('rtdb tags failed (200).')
  })

  it('2: the hidden-project set is read once per Firebase token, not on every call', async () => {
    const { h, world } = await setup()
    await rtdb(h, { path: 'timesheet' })
    await rtdb(h, { path: 'timesheet', groupBy: ['owner'] })
    await rtdb(h, { path: 'projects' })
    const projectReads = rtdbRequests(world).filter((r) => r.url.pathname.endsWith('/projects.json'))
    expect(projectReads).toHaveLength(2)
  })

  it('2: an internal projects read over 10 MB gets its own message', async () => {
    const { h, fw } = await setup()
    fw.rtdbRaw = (url) =>
      url.pathname.endsWith('/projects.json')
        ? new Response(JSON.stringify({ big: 'x'.repeat(10_000_100) }), {
            headers: { 'Content-Type': 'application/json' }
          })
        : undefined
    expect((await rtdb(h, { path: 'timesheet' })).body.error).toBe(
      'projects of this workspace is larger than 10 MB. The MCP reads it to hide projects you may not see, so timesheet cannot be read.'
    )
  })

  it('3: a field below a removed field cannot be used in where / groupBy / fields', async () => {
    const { h, fw, world } = await setup()
    fw.permissions.push('campaigns_app/leads:view')
    for (const args of [
      { where: [{ field: 'contact.email', op: 'eq', value: 'a@b.c' }] },
      { groupBy: ['contact.email'] },
      { fields: ['contact.email'] }
    ]) {
      expect((await rtdb(h, { path: 'deals', ...args })).body.error).toMatch(/"contact.email" is personal data/)
    }
    expect(
      (await rtdb(h, { path: 'projects', where: [{ field: 'deputies.0', op: 'eq', value: ME }] })).body.error
    ).toMatch(/"deputies.0" is personal data/)
    expect(rtdbRequests(world)).toHaveLength(0)
  })

  it('4: only a 500 of s-access means "not set up"; a 503 is a plain failure', async () => {
    const { h, world } = await setup()
    world.backendStatus.set('/_gw/s-access/api/auth/integrations/campaigns/firebase/config', 503)
    const error = String((await rtdb(h, { path: 'tags' })).body.error)
    expect(error).not.toContain('not set up')
    expect(error).toContain('(503)')
  })

  it('5: groupBy on a missing node returns the groups shape', async () => {
    const { h } = await setup()
    expect((await rtdb(h, { path: 'costCenters', groupBy: ['name'], sum: ['x'] })).body).toMatchObject({
      groups: [],
      total: { count: 0, sums: { x: 0 } }
    })
  })

  it('7: an empty Firestore fields list means all fields', async () => {
    const { h, fw, world } = await setup()
    fw.permissions.push('campaigns_app/offers:view')
    fw.firestore[WS_A] = { snapshots: { n1: { name: 'Offer v1', project: 'p1', type: 'pdf' } } }
    expect((await firestore(h, { path: 'snapshots/n1', fields: [] })).body.data).toEqual({
      name: 'Offer v1',
      project: 'p1',
      type: 'pdf'
    })
    expect(firestoreRequests(world).at(-1)?.url.searchParams.getAll('mask.fieldPaths')).toEqual([])
  })

  it('10: the call log holds exactly the documented keys', async () => {
    const { h } = await setup()
    await rtdb(h, { path: 'tags' })
    expect(Object.keys(h.logs.at(-1) ?? {}).sort()).toEqual(
      ['app', 'httpStatus', 'path', 'query', 'realm', 'store', 'time', 'tool', 'user', 'workspace'].sort()
    )
  })

  it('12: invalid paths, unknown nodes, bad budget ids and bad query options send no request at all', async () => {
    const { h, world } = await setup()
    const before = world.requests.length
    await rtdb(h, { path: 'secrets' })
    await rtdb(h, { path: '../x' })
    await rtdb(h, { path: 'tags', equalTo: 'x' })
    await rtdb(h, { path: 'timesheet', where: [{ field: 'description', op: 'exists' }] })
    await firestore(h, { path: 'requests' })
    await h.call('campaigns_budget', { workspace: WS_A, kind: 'projects', id: 'a/b' })
    expect(world.requests.slice(before).map((r) => r.url.pathname)).toEqual([])
  })
})
