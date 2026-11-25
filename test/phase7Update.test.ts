import { afterEach, describe, expect, it } from 'vitest'
import { applyEdits } from '../src/dotPath.js'
import { createHarness, FakeWorld, type Harness, json, STAGE_HOST, WS_A, workspace } from './harness.js'

const EVENT = '/api/events/e1'
const EVENT_GW = `/_gw/s-events${EVENT}`
const SCHEMA = '/api/events/e1/guestschema'
const SCHEMA_PROPERTIES = '/api/events/e1/guestschema/properties'
const TEMPLATE = '/api/emailtemplates/t1'

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

interface Fake {
  getBody: unknown
  getHeaders?: Record<string, string>
  writeStatus?: number
}

async function setup(routes: Record<string, Fake>, allowPersonalData = false) {
  const world = new FakeWorld()
  world.addRealm(STAGE_HOST, { user: 'frank', members: [WS_A], workspaces: [workspace(WS_A, 'Alpha')] })
  const h = await createHarness(world, [STAGE_HOST], undefined, allowPersonalData)
  world.seedRefreshToken(STAGE_HOST, h.store)
  harnesses.push(h)
  for (const [gw, fake] of Object.entries(routes)) {
    world.backendRaw.set(gw, () => {
      const method = world.requests.at(-1)?.method ?? 'GET'
      if (method === 'GET') return json(200, fake.getBody, fake.getHeaders)
      return json(fake.writeStatus ?? 200, fake.writeStatus && fake.writeStatus >= 300 ? undefined : { ok: true })
    })
  }
  return h
}

const event = () => ({
  id: 'e1',
  title: 'Old title',
  start: '2026-12-01',
  settings: { language: 'de', tags: ['a', 'b', 'c'] },
  description: 'long text'
})

function requestsTo(h: Harness, gw: string) {
  return h.world.backendRequests().filter((request) => request.url.pathname === gw)
}

function writesTo(h: Harness, gw: string) {
  return requestsTo(h, gw).filter((request) => request.method !== 'GET')
}

describe('api_update (S4, AC-7.3)', () => {
  it('sends the GET record with only the given paths changed and If-Match from X-ETag', async () => {
    const h = await setup({ [EVENT_GW]: { getBody: event(), getHeaders: { 'X-ETag': '7', ETag: '99' } } })
    const answer = await h.call('api_update', {
      workspace: WS_A,
      method: 'PATCH',
      service: 's-events',
      path: EVENT,
      set: { title: 'New title', 'settings.region': 'EU' },
      remove: ['description']
    })
    expect(answer.isError).toBe(false)
    const [write] = writesTo(h, EVENT_GW)
    expect(write?.method).toBe('PATCH')
    expect(write?.headers['if-match']).toBe('7')
    const { description: _d, ...rest } = event()
    expect(JSON.parse(write?.body ?? 'null')).toEqual({
      ...rest,
      title: 'New title',
      settings: { ...rest.settings, region: 'EU' }
    })
    expect(answer.body).toMatchObject({ status: 200, revisionChecked: true })
    expect(answer.body.changed).toEqual([
      { path: 'description', old: 'long text' },
      { path: 'title', old: 'Old title', new: 'New title' },
      { path: 'settings.region', new: 'EU' }
    ])
    expect(answer.text).not.toContain('2026-12-01')
  })

  it('takes ETag when there is no X-ETag', async () => {
    const h = await setup({ [EVENT_GW]: { getBody: event(), getHeaders: { ETag: '12' } } })
    await h.call('api_update', {
      workspace: WS_A,
      method: 'PUT',
      service: 's-events',
      path: EVENT,
      set: { title: 'T' }
    })
    expect(writesTo(h, EVENT_GW)[0]?.headers['if-match']).toBe('12')
  })

  it.each([409, 412])('a %i is a conflict with one write and no retry', async (status) => {
    const h = await setup({ [EVENT_GW]: { getBody: event(), getHeaders: { 'X-ETag': '7' }, writeStatus: status } })
    const answer = await h.call('api_update', {
      workspace: WS_A,
      method: 'PATCH',
      service: 's-events',
      path: EVENT,
      set: { title: 'T' }
    })
    expect(answer.isError).toBe(true)
    expect(h.logs.map((line) => line.outcome)).toEqual(['ok', 'conflict'])
    expect(h.logs.map((line) => line.httpStatus)).toEqual([200, status])
    expect(requestsTo(h, EVENT_GW).map((request) => request.method)).toEqual(['GET', 'PATCH'])
  })

  it('preview sends only the GET and returns the diff, not the body', async () => {
    const h = await setup({ [EVENT_GW]: { getBody: event(), getHeaders: { 'X-ETag': '7' } } })
    const answer = await h.call('api_update', {
      workspace: WS_A,
      method: 'PATCH',
      service: 's-events',
      path: EVENT,
      set: { title: 'T' },
      preview: true
    })
    expect(answer.isError).toBe(false)
    expect(requestsTo(h, EVENT_GW).map((request) => request.method)).toEqual(['GET'])
    expect(answer.body).toMatchObject({
      preview: true,
      revisionChecked: true,
      request: { method: 'PATCH', path: EVENT, headers: ['If-Match'] },
      changed: [{ path: 'title', old: 'Old title', new: 'T' }]
    })
    expect(answer.text).not.toContain('long text')
    expect(h.logs.map((line) => [(line as { method?: string }).method, line.outcome])).toEqual([
      ['GET', 'ok'],
      ['PATCH', 'preview']
    ])
  })

  it('getPath reads from another path than the write', async () => {
    const h = await setup(
      {
        [`/_gw/s-events-guests${SCHEMA}`]: { getBody: { properties: ['a', 'b'] }, getHeaders: { ETag: '3' } },
        [`/_gw/s-events-guests${SCHEMA_PROPERTIES}`]: { getBody: null }
      },
      true
    )
    const answer = await h.call('api_update', {
      workspace: WS_A,
      method: 'PUT',
      service: 's-events-guests',
      path: SCHEMA_PROPERTIES,
      getPath: SCHEMA,
      set: { 'properties.1': 'c' }
    })
    expect(answer.isError).toBe(false)
    const [write] = writesTo(h, `/_gw/s-events-guests${SCHEMA_PROPERTIES}`)
    expect(write?.headers['if-match']).toBe('3')
    expect(JSON.parse(write?.body ?? 'null')).toEqual({ properties: ['a', 'c'] })
  })

  it('a route without a revision still works and says so', async () => {
    const h = await setup({ [EVENT_GW]: { getBody: event() } })
    const answer = await h.call('api_update', {
      workspace: WS_A,
      method: 'PATCH',
      service: 's-events',
      path: EVENT,
      set: { title: 'T' }
    })
    expect(answer.body).toMatchObject({ revisionChecked: false })
    expect(answer.body.note).toContain('no revision check')
    expect(writesTo(h, EVENT_GW)[0]?.headers['if-match']).toBeUndefined()
  })

  it('a value that is already set writes nothing', async () => {
    const h = await setup({ [EVENT_GW]: { getBody: event(), getHeaders: { 'X-ETag': '7' } } })
    const answer = await h.call('api_update', {
      workspace: WS_A,
      method: 'PATCH',
      service: 's-events',
      path: EVENT,
      set: { title: 'Old title' }
    })
    expect(answer.body).toMatchObject({ status: null, changed: [] })
    expect(writesTo(h, EVENT_GW)).toHaveLength(0)
  })
})

describe('api_update If-Match routes (S4, B3.3)', () => {
  it.each([
    ['s-email-templates', TEMPLATE, 'PATCH', false],
    ['s-email-templates', '/api/events/e1/emailtemplates/t1', 'PATCH', false],
    ['s-events-guests', SCHEMA_PROPERTIES, 'PUT', true],
    ['s-events-guests', '/api/events/e1/guests/g1', 'PATCH', true]
  ])('%s %s without a revision is refused and nothing is written', async (service, path, method, personal) => {
    const gw = `/_gw/${service}${path}`
    const h = await setup({ [gw]: { getBody: { name: 'x' }, getHeaders: { ETag: '0' } } }, personal)
    const answer = await h.call('api_update', { workspace: WS_A, method, service, path, set: { name: 'y' } })
    expect(answer.isError).toBe(true)
    expect(answer.body.error).toContain('needs If-Match, but the GET returned no revision')
    expect(writesTo(h, gw)).toHaveLength(0)
    expect(h.logs.map((line) => line.outcome)).toEqual(['ok', 'refused'])
  })

  it('an email template with a revision is written with If-Match', async () => {
    const gw = `/_gw/s-email-templates${TEMPLATE}`
    const h = await setup({ [gw]: { getBody: { name: 'x', sendingTriggers: ['a'] }, getHeaders: { ETag: '4' } } })
    await h.call('api_update', {
      workspace: WS_A,
      method: 'PATCH',
      service: 's-email-templates',
      path: TEMPLATE,
      set: { name: 'y' }
    })
    const [write] = writesTo(h, gw)
    expect(write?.headers['if-match']).toBe('4')
    expect(JSON.parse(write?.body ?? 'null')).toEqual({ name: 'y', sendingTriggers: ['a'] })
  })
})

describe('api_update refusals before any request (AC-7.4)', () => {
  it.each([
    ['a personal-data service', { service: 's-events-guests', path: '/api/events/e1/guests/g1' }, 'personal data'],
    ['a secret route', { service: 's-workspaces', path: '/api/workspaces/w1/smtp', method: 'PUT' }, 'secret'],
    ['a consumer service', { service: 's-consr-events', path: '/api/x' }, 'not'],
    ['a bad path', { service: 's-events', path: '/api/events/../x' }, 'not allowed'],
    ['an unsafe dot path', { service: 's-events', path: EVENT, set: { '__proto__.x': 1 } }, '"__proto__"'],
    ['no change', { service: 's-events', path: EVENT, set: {} }, 'set and remove are both empty']
  ])('refuses %s', async (_name, input, text) => {
    const h = await setup({})
    const answer = await h.call('api_update', { workspace: WS_A, method: 'PATCH', set: { a: 1 }, ...input })
    expect(answer.isError).toBe(true)
    expect(String(answer.body.error).toLowerCase()).toContain(text.toLowerCase())
    expect(
      h.world.backendRequests().filter((r) => !r.url.pathname.startsWith('/_gw/s-workspaces/api/workspaces'))
    ).toEqual([])
  })

  it('refuses DELETE and POST by schema', async () => {
    const h = await setup({})
    for (const method of ['DELETE', 'POST']) {
      await expect(
        h.call('api_update', { workspace: WS_A, method, service: 's-events', path: EVENT, set: { a: 1 } })
      ).rejects.toThrow('MCP error')
    }
    expect(h.world.backendRequests()).toEqual([])
  })
})

describe('dot paths on arrays (S4)', () => {
  const schema = { properties: ['firstName', 'lastName', 'email', 'company'] }

  it('handles an array body with numeric segments', () => {
    const { record, changes } = applyEdits(['a', 'b', 'c'], { '1': 'B' }, [])
    expect(record).toEqual(['a', 'B', 'c'])
    expect(changes).toEqual([{ path: '1', old: 'b', new: 'B' }])
  })

  it('removes several items by their index in the record as read', () => {
    const { record } = applyEdits(schema, {}, ['properties.1', 'properties.3'])
    expect(record).toEqual({ properties: ['firstName', 'email'] })
  })

  it.each([
    [{ 'properties.4': 'x' }, [], 'outside the array'],
    [{ 'properties.x': 'x' }, [], 'not an index'],
    [{ 'properties.0.name': 'x' }, [], 'is not an object or array'],
    [{ 'properties.2': 'x' }, ['properties.0'], 'would move'],
    [{}, ['properties.9'], 'does not exist'],
    [{}, ['missing'], 'does not exist'],
    [{ properties: [] }, ['properties.0'], 'overlaps']
  ])('refuses set %j remove %j', (set, remove, text) => {
    expect(() => applyEdits(schema, set, remove)).toThrow(text)
  })

  it('creates missing object parents for set', () => {
    expect(applyEdits({}, { 'a.b.c': 1 }, []).record).toEqual({ a: { b: { c: 1 } } })
  })

  it('does not change the record it was given', () => {
    const input = { properties: ['a'] }
    applyEdits(input, { 'properties.0': 'b' }, [])
    expect(input).toEqual({ properties: ['a'] })
  })
})
