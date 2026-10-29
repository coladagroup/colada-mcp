import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createHarness,
  DOCS_PATH,
  EVENT_A,
  FakeWorld,
  type Harness,
  json,
  STAGE_HOST,
  WS_A,
  workspace
} from './harness.js'

const PROD_HOST = 'admin.colada365.com'
const GUESTS = `/api/events/${EVENT_A}/guests`
const GUESTS_DOC = `${DOCS_PATH}/s-events-guests/guests`
const EVENTS_DOC = `${DOCS_PATH}/s-events/events`
const FINANCIALS_DOC = `${DOCS_PATH}/s-events/financials`
const HOUR = 3600

const CATALOG = [
  { service: 's-events-guests', docs: [{ name: 'guests', path: '/api-doc/api-doc.yaml' }] },
  {
    service: 's-events',
    docs: [
      { name: 'events', path: '/api-doc/api-doc.yaml' },
      { name: 'financials', path: '/api-doc/financials/api-doc.yaml' }
    ]
  }
]

const GUESTS_FALSE = `
info:
  x-personal-data: true
paths:
  /api/events/{event_id}/guests:
    get:
      x-personal-data: false
`

const EVENTS_TRUE = `
paths:
  /api/events/{id}:
    get:
      x-personal-data: true
`

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

const yaml = (text: string) => () =>
  new Response(text, { status: 200, headers: { 'Content-Type': 'application/yaml; charset=utf-8' } })

async function setup(options: { allowPersonalData?: boolean; loggedIn?: boolean; hosts?: string[] } = {}) {
  const world = new FakeWorld()
  const hosts = options.hosts ?? [STAGE_HOST]
  for (const [i, host] of hosts.entries()) {
    world.addRealm(host, {
      name: i === 0 ? 'default' : `realm${i}`,
      user: 'frank',
      members: [WS_A],
      workspaces: [workspace(WS_A, 'Alpha', i === 0 ? 'default' : `realm${i}`)]
    })
  }
  world.backendRaw.set(DOCS_PATH, () => json(200, CATALOG))
  world.backendRaw.set(GUESTS_DOC, yaml(GUESTS_FALSE))
  world.backendRaw.set(EVENTS_DOC, yaml(EVENTS_TRUE))
  world.backendRaw.set(FINANCIALS_DOC, yaml('paths: {}\n'))
  world.backendRaw.set(`/_gw/s-events-guests${GUESTS}`, () => json(200, []))
  world.backendRaw.set('/_gw/s-directory-accounts/api/accounts/count', () => json(200, 3))
  world.events.set(WS_A, new Map([[EVENT_A, { uid: EVENT_A }]]))
  const h = await createHarness(world, hosts, undefined, options.allowPersonalData ?? false)
  if (options.loggedIn !== false) for (const host of hosts) world.seedRefreshToken(host, h.store)
  harnesses.push(h)
  return h
}

const getGuests = (h: Harness, realm?: string) =>
  h.call('api_get', { workspace: WS_A, service: 's-events-guests', path: GUESTS, ...(realm ? { realm } : {}) })
const getEvent = (h: Harness) =>
  h.call('api_get', { workspace: WS_A, service: 's-events', path: `/api/events/${EVENT_A}` })
const getCount = (h: Harness) =>
  h.call('api_get', { workspace: WS_A, service: 's-directory-accounts', path: '/api/accounts/count' })
const docPaths = (h: Harness) => h.world.docRequests().map((r) => r.url.pathname)
const markerLines = (h: Harness) => h.stderr.filter((line) => line.startsWith('colada-mcp: markers'))

describe('markers decide check 7 (AC37, AC38, AC40)', () => {
  it('AC37: a false marker sends a call the tables refuse', async () => {
    const h = await setup()
    const result = await getGuests(h)
    expect(result.isError).toBe(false)
    expect(result.body).toMatchObject({ status: 200, body: [] })
    expect(docPaths(h)).toEqual([DOCS_PATH, GUESTS_DOC])
    expect(markerLines(h)).toEqual(['colada-mcp: markers s-events-guests: ok 1 operations'])
  })

  it('AC38: a true marker refuses a call the tables allow, before the tool request', async () => {
    const h = await setup()
    const result = await getEvent(h)
    expect(result.body.error).toContain('may return personal data')
    expect(h.world.toolRequests()).toHaveLength(0)
    expect(docPaths(h)).toEqual([DOCS_PATH, EVENTS_DOC, FINANCIALS_DOC])
  })

  it('AC40: a path the doc does not have is decided by the tables', async () => {
    const h = await setup()
    const result = await h.call('api_get', { workspace: WS_A, service: 's-events-guests', path: '/api/other' })
    expect(result.body.error).toContain('may return personal data')
  })

  it('a service that is not in the catalog is "no doc": the tables decide', async () => {
    const h = await setup()
    expect((await getCount(h)).body).toMatchObject({ status: 200, body: 3 })
    const refused = await h.call('api_get', { workspace: WS_A, service: 's-directory-accounts', path: '/api/accounts' })
    expect(refused.body.error).toContain('may return personal data')
    expect(markerLines(h)).toEqual(['colada-mcp: markers s-directory-accounts: no doc'])
  })

  it('with the switch on no doc is loaded', async () => {
    const h = await setup({ allowPersonalData: true })
    expect((await getEvent(h)).isError).toBe(false)
    expect((await getGuests(h)).isError).toBe(false)
    expect(docPaths(h)).toEqual([])
    expect(markerLines(h)).toEqual([])
  })

  it('a refused secret or delete route loads no doc and sends nothing', async () => {
    const h = await setup()
    await h.call('api_write', {
      workspace: WS_A,
      method: 'PUT',
      service: 's-events',
      path: `/api/events/${EVENT_A}/financialsettings`
    })
    await h.call('api_write', { workspace: WS_A, method: 'PATCH', service: 's-events-guests', path: GUESTS })
    expect(h.world.requests).toHaveLength(0)
  })
})

describe('load failures (CONTRACT-phase3 §3)', () => {
  it.each<[string, (h: Harness) => void, string]>([
    ['403 on the catalog', (h) => h.world.backendStatus.set(DOCS_PATH, 403), 'failed catalog'],
    ['502 on the doc', (h) => h.world.backendStatus.set(GUESTS_DOC, 502), 'failed http 502'],
    ['404 on the doc', (h) => h.world.backendStatus.set(GUESTS_DOC, 404), 'failed http 404'],
    ['YAML error', (h) => h.world.backendRaw.set(GUESTS_DOC, yaml('paths: [\n')), 'failed yaml'],
    ['doc is JSON, not YAML', (h) => h.world.backendRaw.set(GUESTS_DOC, () => json(200, { paths: {} })), 'failed yaml'],
    ['paths is not a map', (h) => h.world.backendRaw.set(GUESTS_DOC, yaml('paths: 1\n')), 'failed yaml'],
    [
      'doc over 512 000 bytes',
      (h) => h.world.backendRaw.set(GUESTS_DOC, yaml(`${GUESTS_FALSE}# ${'x'.repeat(512_000)}\n`)),
      'failed too large'
    ],
    [
      'network error',
      (h) =>
        h.world.backendRaw.set(GUESTS_DOC, () => {
          throw new TypeError('fetch failed')
        }),
      'failed network'
    ],
    [
      'bad doc name in the catalog',
      (h) =>
        h.world.backendRaw.set(DOCS_PATH, () =>
          json(200, [{ service: 's-events-guests', docs: [{ name: '..', path: '/x' }] }])
        ),
      'failed doc name'
    ],
    ['catalog is not a list', (h) => h.world.backendRaw.set(DOCS_PATH, () => json(200, { a: 1 })), 'failed catalog']
  ])('%s: the tables decide', async (_name, breakIt, status) => {
    const h = await setup()
    breakIt(h)
    const result = await getGuests(h)
    expect(result.body.error).toContain('may return personal data')
    expect(markerLines(h)).toEqual([`colada-mcp: markers s-events-guests: ${status}`])
    expect(h.logs.at(-1)?.httpStatus).toBeNull()
  })

  it('one failed doc fails the whole service: no marker of the other doc is used', async () => {
    const h = await setup()
    h.world.backendStatus.set(FINANCIALS_DOC, 502)
    const result = await getEvent(h)
    expect(result.isError).toBe(false)
    expect(markerLines(h)).toEqual(['colada-mcp: markers s-events: failed http 502'])
  })

  it('a 401 on a doc is a failed load: no login, no session end, the tool request still runs', async () => {
    const h = await setup()
    h.world.backendStatus.set(GUESTS_DOC, 401)
    const refreshToken = h.store.values.get(STAGE_HOST)
    const result = await getGuests(h)
    expect(result.body.error).toContain('may return personal data')
    expect(markerLines(h)).toEqual(['colada-mcp: markers s-events-guests: failed http 401'])
    expect(h.opened).toHaveLength(0)
    expect(h.store.values.get(STAGE_HOST)).toBe(refreshToken)
    expect((await getCount(h)).isError).toBe(false)
  })

  it('stderr lines carry no token, no body and no YAML', async () => {
    const h = await setup()
    h.world.backendRaw.set(GUESTS_DOC, yaml('paths: [\nSECRETYAML'))
    await getGuests(h)
    await getEvent(h)
    const text = h.stderr.join('\n')
    for (const value of [...h.world.issued, 'SECRETYAML', 'x-personal-data', 'Bearer']) {
      expect(text).not.toContain(value)
    }
  })
})

describe('cache (D58, AC42)', () => {
  it('one load per host and service per hour; the next call after an hour reloads', async () => {
    const h = await setup()
    await getGuests(h)
    await getGuests(h)
    h.world.now += HOUR - 1
    await getGuests(h)
    expect(docPaths(h)).toEqual([DOCS_PATH, GUESTS_DOC])
    h.world.now += 1
    await getGuests(h)
    await vi.waitFor(() => expect(docPaths(h)).toEqual([DOCS_PATH, GUESTS_DOC, DOCS_PATH, GUESTS_DOC]))
  })

  it('after an hour the call uses the old markers and the reload runs in the background', async () => {
    const h = await setup()
    expect((await getGuests(h)).isError).toBe(false)
    h.world.now += HOUR
    h.world.backendRaw.set(GUESTS_DOC, yaml(GUESTS_FALSE.replace('false', 'true')))
    expect((await getGuests(h)).isError).toBe(false)
    await vi.waitFor(() => expect(markerLines(h)).toHaveLength(2))
    expect((await getGuests(h)).body.error).toContain('may return personal data')
    expect(docPaths(h)).toEqual([DOCS_PATH, GUESTS_DOC, DOCS_PATH, GUESTS_DOC])
  })

  it('a background reload that cannot get a token keeps the old markers', async () => {
    const h = await setup()
    expect((await getGuests(h)).isError).toBe(false)
    h.world.now += HOUR
    h.world.realms.get(STAGE_HOST)?.validRefreshTokens.clear()
    await getGuests(h)
    await vi.waitFor(() => expect(h.opened).toHaveLength(1))
    expect(docPaths(h)).toEqual([DOCS_PATH, GUESTS_DOC])
    expect(markerLines(h)).toHaveLength(1)
  })

  it('the catalog is shared by the services of one host', async () => {
    const h = await setup()
    await getGuests(h)
    await getEvent(h)
    expect(docPaths(h)).toEqual([DOCS_PATH, GUESTS_DOC, EVENTS_DOC, FINANCIALS_DOC])
  })

  it('a failed reload keeps the last good markers', async () => {
    const h = await setup()
    expect((await getGuests(h)).isError).toBe(false)
    h.world.now += HOUR
    h.world.backendStatus.set(GUESTS_DOC, 502)
    expect((await getGuests(h)).isError).toBe(false)
    await vi.waitFor(() =>
      expect(markerLines(h)).toEqual([
        'colada-mcp: markers s-events-guests: ok 1 operations',
        'colada-mcp: markers s-events-guests: failed http 502'
      ])
    )
    expect((await getGuests(h)).isError).toBe(false)
  })

  it('a failed catalog refresh keeps the last good catalog', async () => {
    const h = await setup()
    await getGuests(h)
    h.world.now += HOUR
    h.world.backendStatus.set(DOCS_PATH, 503)
    h.world.backendRaw.set(GUESTS_DOC, yaml(GUESTS_FALSE.replace('false', 'true')))
    await getGuests(h)
    await vi.waitFor(() => expect(markerLines(h)).toHaveLength(2))
    expect(markerLines(h).at(-1)).toBe('colada-mcp: markers s-events-guests: ok 1 operations')
    expect((await getGuests(h)).body.error).toContain('may return personal data')
  })

  it('10 calls after a failed first load send one load in the hour', async () => {
    const h = await setup()
    h.world.backendStatus.set(GUESTS_DOC, 502)
    for (let i = 0; i < 10; i++) await getGuests(h)
    expect(docPaths(h)).toEqual([DOCS_PATH, GUESTS_DOC])
    expect(markerLines(h)).toHaveLength(1)
    h.world.backendStatus.delete(GUESTS_DOC)
    h.world.now += HOUR
    expect((await getGuests(h)).isError).toBe(false)
    expect(docPaths(h)).toHaveLength(4)
  })

  it('10 calls after a failed refresh send one load in the hour', async () => {
    const h = await setup()
    await getGuests(h)
    h.world.now += HOUR
    h.world.backendStatus.set(GUESTS_DOC, 502)
    for (let i = 0; i < 10; i++) expect((await getGuests(h)).isError).toBe(false)
    expect(docPaths(h)).toEqual([DOCS_PATH, GUESTS_DOC, DOCS_PATH, GUESTS_DOC])
  })

  it('parallel calls share one load', async () => {
    const h = await setup()
    h.world.backendDelayMs = 20
    const results = await Promise.all([getGuests(h), getGuests(h), getGuests(h)])
    expect(results.map((result) => result.isError)).toEqual([false, false, false])
    expect(docPaths(h)).toEqual([DOCS_PATH, GUESTS_DOC])
  })

  it('each host has its own catalog and markers', async () => {
    const h = await setup({ hosts: [STAGE_HOST, PROD_HOST] })
    h.world.backendStatus.set(GUESTS_DOC, 502)
    await getGuests(h)
    await getGuests(h, 'realm1')
    expect(h.world.docRequests(STAGE_HOST).map((r) => r.url.pathname)).toEqual([DOCS_PATH, GUESTS_DOC])
    expect(h.world.docRequests(PROD_HOST).map((r) => r.url.pathname)).toEqual([DOCS_PATH, GUESTS_DOC])
  })

  it('a logged-out first call starts the login and loads no doc', async () => {
    const h = await setup({ loggedIn: false })
    const result = await getGuests(h)
    expect(result.body.error).toContain('Login opened in your browser')
    expect(h.opened).toHaveLength(1)
    expect(docPaths(h)).toEqual([])
    expect(markerLines(h)).toEqual([])
    await h.completeLogin()
    expect((await getGuests(h)).isError).toBe(false)
    expect(docPaths(h)).toEqual([DOCS_PATH, GUESTS_DOC])
  })
})

describe('call log (AC48)', () => {
  it('keeps the §7 keys and the status of the tool request', async () => {
    const h = await setup()
    h.world.backendStatus.set(EVENTS_DOC, 502)
    await getGuests(h)
    await getEvent(h)
    for (const entry of h.logs) {
      expect(Object.keys(entry)).toEqual([
        'time',
        'realm',
        'user',
        'workspace',
        'tool',
        'method',
        'service',
        'path',
        'query',
        'ifMatch',
        'httpStatus'
      ])
      expect(entry.httpStatus).toBe(200)
    }
    expect(h.logs).toHaveLength(2)
  })
})
