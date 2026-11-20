import { afterEach, describe, expect, it } from 'vitest'
import { MAX_RESPONSE_BYTES } from '../src/policy/index.js'
import { selectPaths } from '../src/select.js'
import { firebaseSetup, ME } from './firebaseFake.js'
import { createHarness, FakeWorld, type Harness, json, STAGE_HOST, WS_A, WS_B, workspace } from './harness.js'

const GUESTS = '/_gw/s-events-guests/api/events/e1/guests'
const REALM_CONFIG = '/_gw/s-ecosystem/oauthclients/colada-mcp/config'

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

async function setup(allowPersonalData = true) {
  const world = new FakeWorld()
  world.addRealm(STAGE_HOST, {
    user: 'frank',
    members: [WS_A, WS_B],
    workspaces: [workspace(WS_A, 'Alpha'), workspace(WS_B, 'Beta')]
  })
  const h = await createHarness(world, [STAGE_HOST], undefined, allowPersonalData)
  world.seedRefreshToken(STAGE_HOST, h.store)
  harnesses.push(h)
  return h
}

function guest(n: number) {
  return {
    id: `g${n}`,
    status: n % 2 === 0 ? 'REGISTERED' : 'INVITED',
    firstName: `First${n}`,
    lastName: `Last${n}`,
    email: `guest${n}@example.test`,
    answers: { note: 'x'.repeat(4000) },
    sentMailMessages: [
      { id: `m${n}a`, status: 'DELIVERED', subject: 'Invitation' },
      { id: `m${n}b`, status: 'OPENED', subject: 'Reminder' }
    ]
  }
}

const PAGE = Array.from({ length: 500 }, (_, index) => guest(index))
const SELECT = ['id', 'status', 'sentMailMessages.*.status']

describe('selectPaths', () => {
  it('applies each path to every item of a top-level list and merges array items by index', () => {
    expect(selectPaths([guest(1), guest(2)], SELECT)).toEqual([
      { id: 'g1', status: 'INVITED', sentMailMessages: [{ status: 'DELIVERED' }, { status: 'OPENED' }] },
      { id: 'g2', status: 'REGISTERED', sentMailMessages: [{ status: 'DELIVERED' }, { status: 'OPENED' }] }
    ])
    expect(selectPaths([guest(1)], ['*.id'])).toEqual([{ id: 'g1' }])
  })

  it('works on one record and on maps with "*"', () => {
    expect(selectPaths(guest(1), ['id', 'sentMailMessages.*.id'])).toEqual({
      id: 'g1',
      sentMailMessages: [{ id: 'm1a' }, { id: 'm1b' }]
    })
    expect(selectPaths({ a: { name: 'A', x: 1 }, b: { name: 'B' }, c: { x: 2 } }, ['*.name'])).toEqual({
      a: { name: 'A' },
      b: { name: 'B' }
    })
  })

  it('leaves out paths that do not exist and keeps null and 0 values', () => {
    expect(selectPaths({ a: 0, b: null }, ['a', 'b', 'c', 'a.deeper'])).toEqual({ a: 0, b: null })
    expect(selectPaths({ a: 1 }, ['missing'])).toEqual({})
    expect(selectPaths([], ['id'])).toEqual([])
    expect(selectPaths([{ id: 1, status: 'a' }, { id: 2 }], ['status'])).toEqual([{ status: 'a' }, {}])
    expect(selectPaths({ list: [{ a: 1 }, { b: 2 }] }, ['list.*.a'])).toEqual({ list: [{ a: 1 }, {}] })
  })

  it('refuses __proto__, constructor and prototype', () => {
    for (const path of ['__proto__.x', 'a.constructor', 'prototype']) {
      expect(() => selectPaths({}, [path])).toThrow(/is not allowed/)
    }
  })
})

describe('api_get select (AC-6.11, Q17, Q18, Q26)', () => {
  it('a 2 MB guest page: select keeps only the paths of every item and Content-Range', async () => {
    const h = await setup()
    const body = JSON.stringify(PAGE)
    expect(Buffer.byteLength(body)).toBeGreaterThan(2_000_000)
    h.world.backendRaw.set(GUESTS, () => json(200, PAGE, { 'Content-Range': 'guests 0-500/1200' }))

    const result = await h.call('api_get', {
      workspace: WS_A,
      service: 's-events-guests',
      path: '/api/events/e1/guests',
      headers: { Range: 'guests 0-500' },
      select: SELECT
    })

    expect(result.isError).toBe(false)
    expect(result.body.headers).toEqual({ 'Content-Range': 'guests 0-500/1200' })
    expect(result.body.selected).toEqual(SELECT)
    expect(result.body.body).toHaveLength(500)
    for (const [index, item] of (result.body.body as Array<Record<string, unknown>>).entries()) {
      expect(item).toEqual({
        id: `g${index}`,
        status: index % 2 === 0 ? 'REGISTERED' : 'INVITED',
        sentMailMessages: [{ status: 'DELIVERED' }, { status: 'OPENED' }]
      })
    }
    expect(result.text).not.toMatch(/First|guest\d+@|Invitation/)
  })

  it('without select the same page is refused with a message naming select', async () => {
    const h = await setup()
    h.world.backendRaw.set(GUESTS, () => json(200, PAGE))
    const result = await h.call('api_get', {
      workspace: WS_A,
      service: 's-events-guests',
      path: '/api/events/e1/guests'
    })
    expect(result.isError).toBe(true)
    expect(result.body.error).toContain('larger than 500 KB')
    expect(result.body.error).toContain('"select"')
    expect(h.logs.at(-1)).toMatchObject({ outcome: 'refused', reason: 'tooLarge' })
  })

  it('an answer still over 500 KB after select is refused', async () => {
    const h = await setup()
    h.world.backendRaw.set(GUESTS, () => json(200, PAGE))
    const result = await h.call('api_get', {
      workspace: WS_A,
      service: 's-events-guests',
      path: '/api/events/e1/guests',
      select: ['answers']
    })
    expect(result.isError).toBe(true)
    expect(result.body.error).toContain('larger than 500 KB')
  })

  it('a GET over 10 MB is refused at download', async () => {
    const h = await setup()
    const big = 'x'.repeat(11_000_000)
    h.world.backendRaw.set('/_gw/s-events/api/events', () => json(200, [big]))
    const result = await h.call('api_get', {
      workspace: WS_A,
      service: 's-events',
      path: '/api/events',
      select: ['id']
    })
    expect(result.isError).toBe(true)
    expect(result.body.error).toContain('larger than 10 MB and was not downloaded')
    expect(h.logs.at(-1)).toMatchObject({ outcome: 'refused', reason: 'tooLarge' })
  })

  it('without select a GET is still cut at 500 KB, not downloaded up to 10 MB', async () => {
    const h = await setup()
    h.world.backendRaw.set('/_gw/s-events/api/events', () => json(200, ['x'.repeat(11_000_000)]))
    const result = await h.call('api_get', { workspace: WS_A, service: 's-events', path: '/api/events' })
    expect(result.isError).toBe(true)
    expect(result.body.error).toContain('larger than 500 KB')
  })

  it('a write keeps the 500 KB read limit (body note, not 10 MB)', async () => {
    const h = await setup()
    h.world.backendRaw.set('/_gw/s-events/api/events/e1', () => json(200, 'x'.repeat(MAX_RESPONSE_BYTES + 10)))
    const result = await h.call('api_write', {
      workspace: WS_A,
      method: 'PUT',
      service: 's-events',
      path: '/api/events/e1',
      body: {}
    })
    expect(result.body.bodyNote).toContain('it is larger than 500 KB')
  })

  it('with personal data off, select on a blocked route is refused before any backend request', async () => {
    const h = await setup(false)
    const result = await h.call('api_get', {
      workspace: WS_A,
      service: 's-events-guests',
      path: '/api/events/e1/guests',
      select: ['id']
    })
    expect(result.isError).toBe(true)
    expect(result.body.error).toContain('COLADA_ALLOW_PERSONAL_DATA=true')
    expect(h.world.backendRequests().filter((request) => request.url.pathname !== REALM_CONFIG)).toEqual([])
  })

  it('the schema refuses 0 and 51 paths and an empty segment', async () => {
    const h = await setup()
    for (const select of [[], Array.from({ length: 51 }, (_, i) => `f${i}`), ['a..b']]) {
      const result = await h.client.callTool({
        name: 'api_get',
        arguments: { workspace: WS_A, service: 's-events', path: '/api/events', select }
      })
      expect(result.isError).toBe(true)
    }
  })
})

describe('rtdb_get select (AC-6.11)', () => {
  async function rtdbSetup() {
    const result = await firebaseSetup()
    harnesses.push(result.h)
    result.fw.permissions = ['campaigns_app:view', 'campaigns_app/reports:view']
    result.fw.rtdb[WS_A] = {
      timesheet: {
        t1: { uid: 't1', owner: ME, date: '2026-09-02', hours: 2, project: 'p1', description: 'met John' },
        t2: { uid: 't2', owner: ME, date: '2026-09-03', hours: 1, project: 'p2', description: 'call Anna' }
      }
    }
    return result
  }

  it('a select path that names a hidden field returns no value for it (personal data off)', async () => {
    const { h } = await rtdbSetup()
    const result = await h.call('rtdb_get', {
      workspace: WS_A,
      app: 'campaigns',
      path: 'timesheet',
      select: ['*.hours', '*.description']
    })
    expect(result.body.error).toBeUndefined()
    expect(result.isError).toBe(false)
    expect(result.body.data).toEqual({ t1: { hours: 2 }, t2: { hours: 1 } })
    expect(result.body.removedFields).toContain('description')
    expect(result.body.selected).toEqual(['*.hours', '*.description'])
    expect(result.text).not.toMatch(/John|Anna/)
    expect(h.logs.at(-1)).toMatchObject({ query: { select: ['*.hours', '*.description'] } })
  })

  it('select cannot be combined with groupBy', async () => {
    const { h } = await rtdbSetup()
    const result = await h.call('rtdb_get', {
      workspace: WS_A,
      app: 'campaigns',
      path: 'timesheet',
      groupBy: ['project'],
      select: ['*.project']
    })
    expect(result.isError).toBe(true)
    expect(result.body.error).toContain('select cannot be combined with shallow, groupBy or sum')
  })
})
