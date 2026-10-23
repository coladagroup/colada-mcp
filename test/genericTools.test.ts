import { afterEach, describe, expect, it } from 'vitest'
import { MAX_RESPONSE_BYTES } from '../src/policy/index.js'
import {
  createHarness,
  EVENT_A,
  FakeWorld,
  type Harness,
  json,
  STAGE_HOST,
  WS_A,
  WS_B,
  WS_FOREIGN,
  workspace
} from './harness.js'

const RESOURCE = '/_gw/s-events-resources/api/events/e1/resources/r1'
const CATALOG = '/_gw/s-ecosystem/api/api-docs'
const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

async function setup(options: { allowPersonalData?: boolean } = {}) {
  const world = new FakeWorld()
  world.addRealm(STAGE_HOST, {
    user: 'frank',
    members: [WS_A, WS_B],
    workspaces: [workspace(WS_A, 'Alpha'), workspace(WS_B, 'Beta')]
  })
  world.events.set(WS_A, new Map([[EVENT_A, { uid: EVENT_A }]]))
  const h = await createHarness(world, [STAGE_HOST], undefined, options.allowPersonalData ?? false)
  world.seedRefreshToken(STAGE_HOST, h.store)
  harnesses.push(h)
  return h
}

const yaml = (text: string) =>
  new Response(text, { status: 200, headers: { 'Content-Type': 'application/yaml; charset=utf-8' } })

describe('tools/list (AC24, AC32)', () => {
  it('offers exactly the five phase 2 tools with the CONTRACT annotations', async () => {
    const h = await setup()
    const { tools } = await h.client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual([
      'list_workspaces',
      'get_conventions',
      'get_api_doc',
      'api_get',
      'api_write',
      'logout'
    ])
    const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]))
    expect(annotations.get_api_doc).toEqual({ readOnlyHint: true })
    expect(annotations.api_get).toEqual({ readOnlyHint: true })
    expect(annotations.api_write).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false })
  })
})

describe('api_get (AC19)', () => {
  it('sends query and Range, returns status, body and the response headers', async () => {
    const h = await setup()
    h.world.backendRaw.set(RESOURCE, () =>
      json(200, [{ id: 'r1' }], { 'Content-Range': 'resources 0-1/1', ETag: 'rev-1', 'Set-Cookie': 'a=b' })
    )
    const result = await h.call('api_get', {
      workspace: 'Alpha',
      service: 's-events-resources',
      path: '/api/events/e1/resources/r1',
      query: { q: 'status=!FINISHED', 'a b': 'x&y' },
      headers: { range: 'resources 0-100' }
    })

    expect(result.isError).toBe(false)
    expect(result.body).toMatchObject({
      status: 200,
      headers: { 'Content-Range': 'resources 0-1/1', ETag: 'rev-1' },
      body: [{ id: 'r1' }]
    })
    const [request] = h.world.backendRequests().filter((r) => r.url.pathname === RESOURCE)
    expect(request?.url.search).toBe('?q=status%3D!FINISHED&a%20b=x%26y')
    expect(request?.headers.range).toBe('resources 0-100')
    expect(request?.method).toBe('GET')
    expect(Object.keys(request?.headers ?? {}).filter((name) => name.startsWith('x-colada'))).toEqual([])
  })

  it('refuses a body over 500 KB (AC28)', async () => {
    const h = await setup()
    h.world.backendRaw.set(RESOURCE, () => json(200, 'x'.repeat(MAX_RESPONSE_BYTES)))
    const result = await h.call('api_get', {
      workspace: WS_A,
      service: 's-events-resources',
      path: '/api/events/e1/resources/r1'
    })
    expect(result.body.error).toContain('is larger than 500 KB and is not returned')
    expect(result.text).not.toContain('xxxx')
  })
})

describe('api_write (AC20, AC36)', () => {
  it('sends PUT with body and If-Match; the log has no body and no header value', async () => {
    const h = await setup()
    h.world.backendRaw.set(RESOURCE, () => json(200, { id: 'r1', title: 'NEWTITLE' }, { ETag: 'rev-2' }))
    const result = await h.call('api_write', {
      workspace: WS_A,
      method: 'put',
      service: 's-events-resources',
      path: '/api/events/e1/resources/r1',
      headers: { 'If-Match': 'REVVALUE' },
      body: { title: 'NEWTITLE' }
    })

    expect(result.body).toMatchObject({ status: 200, headers: { ETag: 'rev-2' }, body: { title: 'NEWTITLE' } })
    const [request] = h.world.backendRequests().filter((r) => r.url.pathname === RESOURCE)
    expect(request?.method).toBe('PUT')
    expect(request?.body).toBe('{"title":"NEWTITLE"}')
    expect(request?.headers['if-match']).toBe('REVVALUE')
    expect(request?.headers['content-type']).toBe('application/json')
    expect(h.logs.at(-1)).toMatchObject({ tool: 'api_write', method: 'PUT', ifMatch: true, httpStatus: 200 })
    expect(JSON.stringify(h.logs)).not.toMatch(/NEWTITLE|REVVALUE/)
  })

  it('a write that gets 401 is sent once and not again', async () => {
    const h = await setup()
    h.world.backendStatus.set(RESOURCE, 401)
    const result = await h.call('api_write', {
      workspace: WS_A,
      method: 'POST',
      service: 's-events-resources',
      path: '/api/events/e1/resources/r1',
      body: {}
    })
    expect(result.body.error).toContain('was refused (401)')
    expect(h.world.backendRequests().filter((r) => r.url.pathname === RESOURCE)).toHaveLength(1)
  })

  it('a 2xx write whose body is not JSON returns the status and a bodyNote', async () => {
    const h = await setup()
    h.world.backendRaw.set(
      RESOURCE,
      () => new Response('ok', { status: 201, headers: { 'Content-Type': 'text/plain' } })
    )
    const result = await h.call('api_write', {
      workspace: WS_A,
      method: 'POST',
      service: 's-events-resources',
      path: '/api/events/e1/resources/r1'
    })
    expect(result.isError).toBe(false)
    expect(result.body).toMatchObject({ status: 201, body: null })
    expect(result.body.bodyNote).toContain('The change was applied')
  })
})

describe('refusals send nothing (AC21–AC23, AC25–AC27, AC30)', () => {
  it.each([
    [
      'DELETE',
      { method: 'DELETE', service: 's-events', path: '/api/events/e1' },
      'only DELETE routes on the MCP allowlist'
    ],
    ['GET method', { method: 'GET', service: 's-events', path: '/api/events/e1' }, 'is not supported by api_write'],
    [
      'delete denylist',
      { method: 'POST', service: 's-directory-contacts', path: '/api/contacts/delete/jobs' },
      'this route deletes data'
    ],
    [
      'secret route',
      { method: 'PUT', service: 's-workspaces', path: `/api/workspaces/${WS_A}/smtp` },
      'reads or changes secrets'
    ],
    [
      'personal data',
      { method: 'PATCH', service: 's-events-guests', path: '/api/events/e1/guests/g1' },
      'holds personal data'
    ],
    [
      'X-Colada header',
      { method: 'PUT', service: 's-events', path: '/api/events/e1', headers: { 'X-Colada-Workspace-Id': WS_B } },
      'Header "X-Colada-Workspace-Id" is not allowed'
    ],
    ['CONSR service', { method: 'POST', service: 's-consr-profiles', path: '/api/profiles' }, 'is not allowed']
  ])('api_write %s', async (_name, args, text) => {
    const h = await setup()
    const result = await h.call('api_write', { workspace: WS_A, ...args })
    expect(result.isError).toBe(true)
    expect(result.body.error).toContain(text)
    expect(h.world.requests).toHaveLength(0)
    expect(h.opened).toHaveLength(0)
    expect(h.logs.at(-1)?.httpStatus).toBeNull()
  })

  it('api_get on a personal-data service is refused with the switch off and sent with it on', async () => {
    const off = await setup()
    const refused = await off.call('api_get', {
      workspace: WS_A,
      service: 's-events-guests',
      path: '/api/events/e1/guests'
    })
    expect(refused.body.error).toContain('COLADA_ALLOW_PERSONAL_DATA=true')
    expect(off.world.requests).toHaveLength(0)

    const on = await setup({ allowPersonalData: true })
    on.world.backendRaw.set('/_gw/s-events-guests/api/events/e1/guests', () => json(200, []))
    const sent = await on.call('api_get', {
      workspace: WS_A,
      service: 's-events-guests',
      path: '/api/events/e1/guests'
    })
    expect(sent.body).toMatchObject({ status: 200, body: [] })
  })

  it('AC30: a workspace without the claim gives "no access" and no backend request', async () => {
    const h = await setup()
    const result = await h.call('api_get', {
      workspace: WS_FOREIGN,
      service: 's-events',
      path: `/api/events/${EVENT_A}`
    })
    expect(result.body.error).toBe(
      `No access to workspace ${WS_FOREIGN} in realm default. You are not a member of it, it does not exist, or it belongs to another realm (see list_workspaces).`
    )
    expect(h.world.backendRequests()).toHaveLength(0)
  })
})

describe('get_api_doc (AC29)', () => {
  const catalog = [
    {
      service: 's-events',
      docs: [
        { name: 'events', path: '/api-doc/api-doc.yaml' },
        { name: 'financials', path: '/x' }
      ]
    },
    { service: 's-events-resources', docs: [{ name: 'events-resources', path: '/api-doc/api-doc.yaml' }] }
  ]

  async function withCatalog() {
    const h = await setup()
    h.world.backendRaw.set(CATALOG, () => json(200, catalog))
    return h
  }

  it('without service returns the catalog, with workspace null and the base token', async () => {
    const h = await withCatalog()
    const result = await h.call('get_api_doc')
    expect(result.body).toMatchObject({ realm: 'default', user: 'frank', workspace: null, services: catalog })
    expect(h.world.tokenRequests().every((r) => !r.form?.has('workspace_id'))).toBe(true)
    expect(h.logs.at(-1)).toMatchObject({
      tool: 'get_api_doc',
      method: 'GET',
      service: 's-ecosystem',
      path: '/api/api-docs',
      workspace: null,
      httpStatus: 200
    })
  })

  it('a service with one doc returns its YAML', async () => {
    const h = await withCatalog()
    h.world.backendRaw.set(`${CATALOG}/s-events-resources/events-resources`, () => yaml('openapi: 3.0.0\n'))
    const result = await h.call('get_api_doc', { service: 's-events-resources' })
    expect(result.body).toMatchObject({
      service: 's-events-resources',
      doc: 'events-resources',
      apiDoc: 'openapi: 3.0.0\n'
    })
    expect(h.logs.at(-1)).toMatchObject({ path: '/api/api-docs/s-events-resources/events-resources' })
  })

  it('service and doc fetch the doc directly', async () => {
    const h = await withCatalog()
    h.world.backendRaw.set(`${CATALOG}/s-events/financials`, () => yaml('openapi: 3.0.1\n'))
    const result = await h.call('get_api_doc', { service: 's-events', doc: 'financials' })
    expect(result.body.apiDoc).toBe('openapi: 3.0.1\n')
    expect(h.world.backendRequests().map((r) => r.url.pathname)).toEqual([`${CATALOG}/s-events/financials`])
  })

  it.each([
    [{ service: 's-events' }, 'Service s-events has several API docs: events, financials. Pass "doc".'],
    [{ service: 's-unknown' }, 'No API docs for service "s-unknown". Call get_api_doc without service for the list.'],
    [{ doc: 'events' }, 'Pass "service" together with "doc".'],
    [
      { service: 's-events', doc: 'nope' },
      'No API doc "nope" for service "s-events". Call get_api_doc with only the service to see its docs.'
    ]
  ])('%o → error', async (args, message) => {
    const h = await withCatalog()
    const result = await h.call('get_api_doc', args)
    expect(result.body.error).toBe(message)
  })

  it('refuses a CONSR or malformed service before any request', async () => {
    const h = await withCatalog()
    const result = await h.call('get_api_doc', { service: 's-consr-profiles' })
    expect(result.body.error).toContain('Service "s-consr-profiles" is not allowed.')
    expect(h.world.requests).toHaveLength(0)
  })

  it('403 names the permission', async () => {
    const h = await setup()
    h.world.backendStatus.set(CATALOG, 403)
    const result = await h.call('get_api_doc')
    expect(result.body.error).toBe(
      'get_api_doc was refused (403): your role lacks the permission api:api-doc:view. Ask an admin.'
    )
  })

  it('a 144 KB doc is returned (limit raised to 500 KB at Gate 10)', async () => {
    const h = await withCatalog()
    h.world.backendRaw.set(`${CATALOG}/s-events/events`, () => yaml('x'.repeat(144_430)))
    const result = await h.call('get_api_doc', { service: 's-events', doc: 'events' })
    expect(result.body.apiDoc).toHaveLength(144_430)
  })

  it('a doc over 500 KB is refused', async () => {
    const h = await withCatalog()
    h.world.backendRaw.set(`${CATALOG}/s-events/events`, () => yaml('x'.repeat(MAX_RESPONSE_BYTES + 1)))
    const result = await h.call('get_api_doc', { service: 's-events', doc: 'events' })
    expect(result.body.error).toBe('The API doc s-events/events is larger than 500 KB and is not returned.')
  })
})
