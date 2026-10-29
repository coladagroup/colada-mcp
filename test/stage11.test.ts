import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, EVENT_A, FakeWorld, type Harness, STAGE_HOST, WS_A, WS_B, workspace } from './harness.js'

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

async function setup(allowPersonalData = false) {
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

const sentPaths = (h: Harness) =>
  h.world
    .backendRequests()
    .filter((r) => !r.url.pathname.endsWith('/s-workspaces/api/workspaces'))
    .map((r) => `${r.method} ${r.url.pathname}`)

describe('delete and secret routes stay blocked with the personal-data switch on', () => {
  const writes: [string, string, string][] = [
    ['POST', 's-events-guests', `/api/events/${EVENT_A}/guests/delete/jobs:(id)`],
    ['POST', 's-events-guests', `/api/events/${EVENT_A}/guests/delete/jobs:(id,name)`],
    ['POST', 's-events-invoices', '/api/guestsinvoices/remove/jobs'],
    ['POST', 's-events-invoices', `/api/events/${EVENT_A}/brokersinvoices/remove/jobs`],
    ['POST', 's-access', '/api/auth/integrations/games/firebase/token'],
    ['GET', 's-access', '/api/auth/integrations/campaigns/firebase/config'],
    ['GET', 's-access', '/api/auth/integrations/campaigns/firebase/config:(apiKey)'],
    ['PUT', 's-workspaces', '/api/workspaces/w1/smtp:(host)']
  ]
  for (const [method, service, path] of writes) {
    it(`${method} ${service} ${path} is not sent`, async () => {
      const h = await setup(true)
      const call = method === 'GET' ? 'api_get' : 'api_write'
      const result = await h.call(call, { workspace: WS_A, method, service, path, body: {} })
      expect(result.isError).toBe(true)
      expect(sentPaths(h)).toEqual([])
    })
  }
})

describe('allowlist rows match the exact case of the path', () => {
  it('GET /api/accounts/Count is not sent', async () => {
    const h = await setup()
    await h.call('api_get', { workspace: WS_A, service: 's-directory-accounts', path: '/api/accounts/Count' })
    expect(sentPaths(h)).toEqual([])
  })

  it('a Kelvin sign that lower-cases to "k" does not open allowlist A03', async () => {
    const h = await setup()
    await h.call('api_write', {
      workspace: WS_A,
      method: 'POST',
      service: 's-documents',
      path: '/api/events/e1/documents/tic%E2%84%AAet/templates'
    })
    expect(sentPaths(h)).toEqual([])
  })

  it('GET /api/accounts/count is still sent', async () => {
    const h = await setup()
    await h.call('api_get', { workspace: WS_A, service: 's-directory-accounts', path: '/api/accounts/count' })
    expect(sentPaths(h)).toEqual(['GET /_gw/s-directory-accounts/api/accounts/count'])
  })
})

describe('encoded Unicode space and control characters are refused', () => {
  for (const encoded of ['%C2%85', '%C2%9B', '%C2%A0', '%E2%80%A8', '%E2%80%8B', '%EF%BB%BF']) {
    it(`refuses ${encoded}`, async () => {
      const h = await setup()
      await h.call('api_get', { workspace: WS_A, service: 's-events', path: `/api/events/e1${encoded}` })
      expect(sentPaths(h)).toEqual([])
    })
  }
})

describe('get_api_doc doc names', () => {
  for (const doc of ['.', '..', 'a/b', '']) {
    it(`refuses doc ${JSON.stringify(doc)} without a request`, async () => {
      const h = await setup()
      const result = await h.call('get_api_doc', { service: 's-events', doc })
      expect(result.isError).toBe(true)
      expect(h.world.backendRequests().filter((r) => r.url.pathname.includes('api-docs'))).toEqual([])
    })
  }
})

describe('If-Match values', () => {
  for (const value of ['a\u0000b', 'rev\u0085', 'r€v']) {
    it(`refuses ${JSON.stringify(value)} before sending`, async () => {
      const h = await setup()
      const result = await h.call('api_write', {
        workspace: WS_A,
        method: 'PUT',
        service: 's-events',
        path: '/api/events/e1',
        headers: { 'If-Match': value },
        body: {}
      })
      expect(String(result.body.error)).toContain('If-Match')
      expect(sentPaths(h)).toEqual([])
    })
  }
})

describe('call log through the registered tools', () => {
  const KEYS = [
    'httpStatus',
    'ifMatch',
    'method',
    'path',
    'query',
    'realm',
    'service',
    'time',
    'tool',
    'user',
    'workspace'
  ]

  it('api_get, api_write and get_api_doc write exactly the CONTRACT §7 keys', async () => {
    const h = await setup()
    await h.call('api_get', {
      workspace: WS_A,
      service: 's-events',
      path: '/api/events',
      headers: { Range: 'events 0-9' }
    })
    await h.call('api_write', {
      workspace: WS_A,
      method: 'PUT',
      service: 's-events',
      path: '/api/events/e1',
      headers: { 'If-Match': 'REV' },
      body: { note: 'BODYMARK' }
    })
    await h.call('get_api_doc', {})
    const generic = h.logs.filter((entry) => ['api_get', 'api_write', 'get_api_doc'].includes(String(entry.tool)))
    expect(generic).toHaveLength(3)
    for (const entry of generic) expect(Object.keys(entry).sort()).toEqual(KEYS)
    expect(JSON.stringify(h.logs)).not.toMatch(/BODYMARK|REV"|events 0-9/)
  })
})
