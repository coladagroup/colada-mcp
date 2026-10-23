import { afterEach, describe, expect, it } from 'vitest'
import { callBackend } from '../src/api/backend.js'
import { ApiClient } from '../src/api/client.js'
import { checkWrite, MAX_RESPONSE_BYTES } from '../src/policy/index.js'
import { apiCallOf, openRealm, runApiTool } from '../src/tools/run.js'
import { createHarness, FakeWorld, type Harness, json, STAGE_HOST, WS_A, workspace } from './harness.js'

const PATH = '/_gw/s-events-resources/api/events/e1/resources/r1'

const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

async function setup() {
  const world = new FakeWorld()
  world.addRealm(STAGE_HOST, { user: 'frank', members: [WS_A], workspaces: [workspace(WS_A, 'Alpha')] })
  const h = await createHarness(world)
  world.seedRefreshToken(STAGE_HOST, h.store)
  harnesses.push(h)
  const { session } = await h.app.realm(undefined)
  return { h, world, session }
}

function stubClient(response: () => Response) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const client = new ApiClient(async (input, init) => {
    calls.push({ url: String(input), init })
    return response()
  })
  return { client, calls }
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise
  } catch (err) {
    return (err as Error).message
  }
  return null
}

describe('ApiClient.request (CONTRACT §2, §5)', () => {
  it('sends the method, the MCP headers and a JSON body', async () => {
    const { client, calls } = stubClient(() => json(201, { id: 'r1' }))
    const response = await client.request(
      'POST',
      'h.example.com',
      `${PATH}?a=1`,
      'tkn',
      { 'If-Match': 'r1' },
      {
        body: { title: 'x' }
      }
    )
    expect(response.body).toEqual({ id: 'r1' })
    const [call] = calls
    expect(call?.url).toBe(`https://h.example.com${PATH}?a=1`)
    expect(call?.init?.method).toBe('POST')
    expect(call?.init?.body).toBe('{"title":"x"}')
    expect(call?.init?.redirect).toBe('error')
    expect(call?.init?.headers).toEqual({
      'If-Match': 'r1',
      Authorization: 'Bearer tkn',
      Accept: 'application/json',
      'Accept-Language': 'en',
      'Content-Type': 'application/json'
    })
  })

  it('sends no body and no Content-Type without a body', async () => {
    const { client, calls } = stubClient(() => json(200, {}))
    await client.request('POST', 'h.example.com', PATH, 'tkn')
    expect(calls[0]?.init?.body).toBeUndefined()
    expect(calls[0]?.init?.headers).not.toHaveProperty('Content-Type')
  })

  it.each([204, 200, 201])('an empty %s body is null', async (status) => {
    const { client } = stubClient(() => new Response(status === 204 ? null : '', { status }))
    expect((await client.request('PUT', 'h.example.com', PATH, 'tkn')).body).toBeNull()
  })

  it('returns YAML as text', async () => {
    const yaml = 'openapi: 3.0.0\n'
    const { client } = stubClient(
      () => new Response(yaml, { status: 200, headers: { 'Content-Type': 'application/yaml; charset=utf-8' } })
    )
    expect((await client.request('GET', 'h.example.com', PATH, 'tkn')).body).toBe(yaml)
  })

  it('refuses other content types', async () => {
    const { client } = stubClient(() => new Response('a,b', { status: 200, headers: { 'Content-Type': 'text/csv' } }))
    expect(await errorOf(client.request('GET', 'h.example.com', PATH, 'tkn'))).toBe(
      `GET ${PATH} returned text/csv, not JSON. File downloads are not supported.`
    )
  })

  it('refuses invalid JSON', async () => {
    const { client } = stubClient(
      () => new Response('{"a":', { status: 200, headers: { 'Content-Type': 'application/json' } })
    )
    expect(await errorOf(client.request('GET', 'h.example.com', PATH, 'tkn'))).toBe(
      `GET ${PATH} returned invalid JSON (200).`
    )
  })

  it('a read without a response names the method', async () => {
    const client = new ApiClient(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await errorOf(client.request('GET', 'h.example.com', `${PATH}?x=1`, 'tkn'))).toBe(
      `GET ${PATH} failed (no response).`
    )
  })

  describe('500 KB limit (AC28)', () => {
    const tooLarge = `The response of GET ${PATH} is larger than 500 KB and is not returned. Ask for less: a smaller Range (for example "Range: events 0-20"), a narrower query, or a projection in the path (for example /api/events:(title,start)).`
    const jsonOfSize = (bytes: number) => `"${'a'.repeat(bytes - 2)}"`
    const streamed = (text: string) =>
      new Response(
        new ReadableStream({
          start(controller) {
            const bytes = new TextEncoder().encode(text)
            for (let i = 0; i < bytes.length; i += 8192) controller.enqueue(bytes.slice(i, i + 8192))
            controller.close()
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )

    it('accepts exactly 500 KB', async () => {
      const { client } = stubClient(() => streamed(jsonOfSize(MAX_RESPONSE_BYTES)))
      const response = await client.request('GET', 'h.example.com', PATH, 'tkn', {}, { maxBytes: MAX_RESPONSE_BYTES })
      expect(typeof response.body).toBe('string')
    })

    it('refuses 500 KB + 1 byte read from the stream', async () => {
      const { client } = stubClient(() => streamed(jsonOfSize(MAX_RESPONSE_BYTES + 1)))
      expect(
        await errorOf(client.request('GET', 'h.example.com', PATH, 'tkn', {}, { maxBytes: MAX_RESPONSE_BYTES }))
      ).toBe(tooLarge)
    })

    it('refuses by Content-Length before reading', async () => {
      const { client } = stubClient(
        () =>
          new Response('{}', {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Content-Length': String(MAX_RESPONSE_BYTES + 1) }
          })
      )
      expect(
        await errorOf(client.request('GET', 'h.example.com', PATH, 'tkn', {}, { maxBytes: MAX_RESPONSE_BYTES }))
      ).toBe(tooLarge)
    })
  })
})

describe('callBackend (CONTRACT §2, §5)', () => {
  it('returns status, body and the four response headers only', async () => {
    const { world, session } = await setup()
    world.backendRaw.set(PATH, () =>
      json(200, [{ id: 'r1' }], {
        'Content-Range': 'resources 0-1/1',
        etag: 'rev-1',
        'X-ETag': 'rev-x',
        Location: '/api/x',
        'Set-Cookie': 'a=b',
        'X-Other': 'y'
      })
    )
    const response = await callBackend(
      new ApiClient(world.fetch),
      session,
      { workspaceId: WS_A, path: PATH },
      { httpStatus: null }
    )
    expect(response.status).toBe(200)
    expect(response.body).toEqual([{ id: 'r1' }])
    expect(response.returnedHeaders).toEqual({
      'Content-Range': 'resources 0-1/1',
      ETag: 'rev-1',
      'X-ETag': 'rev-x',
      Location: '/api/x'
    })
  })

  it('sends a write with its method and body', async () => {
    const { world, session } = await setup()
    world.backendRaw.set(PATH, () => new Response(null, { status: 204 }))
    const response = await callBackend(
      new ApiClient(world.fetch),
      session,
      { workspaceId: WS_A, method: 'PUT', path: PATH, body: { title: 'x' } },
      { httpStatus: null }
    )
    expect(response.body).toBeNull()
    const [request] = world.backendRequests()
    expect(request?.method).toBe('PUT')
    expect(request?.body).toBe('{"title":"x"}')
  })

  it.each([
    [403, `PUT ${PATH} was refused (403): your role lacks access to this endpoint. Ask an admin for the permission.`],
    [
      409,
      `PUT ${PATH} was refused (409): the object changed since you read it. Read it again with api_get and pass the new ETag as If-Match.`
    ],
    [
      412,
      `PUT ${PATH} was refused (412): the object changed since you read it. Read it again with api_get and pass the new ETag as If-Match.`
    ],
    [
      428,
      `PUT ${PATH} was refused (428): this route needs If-Match. Read the object with api_get and pass its ETag as If-Match.`
    ],
    [500, `PUT ${PATH} failed (500).`]
  ])('maps %i to its text with the method', async (status, message) => {
    const { world, session } = await setup()
    world.backendStatus.set(PATH, status)
    const request = { workspaceId: WS_A, method: 'PUT', path: PATH }
    expect(await errorOf(callBackend(new ApiClient(world.fetch), session, request, { httpStatus: null }))).toBe(message)
  })

  it('AC36: a write that gets 401 is sent exactly once and the token is invalidated', async () => {
    const { world, session } = await setup()
    world.backendStatus.set(PATH, 401)
    const state = { httpStatus: null }
    const api = new ApiClient(world.fetch)
    const request = { workspaceId: WS_A, method: 'POST', path: PATH, body: { a: 1 } }

    expect(await errorOf(callBackend(api, session, request, state))).toBe(
      `POST ${PATH} was refused (401): the session token was not accepted. The request was not sent again. Call api_write again; the user approves it again.`
    )
    expect(world.backendRequests()).toHaveLength(1)
    expect(state.httpStatus).toBe(401)

    const tokensBefore = world.tokenRequests().length
    world.backendStatus.delete(PATH)
    world.backendRaw.set(PATH, () => json(201, {}))
    await callBackend(api, session, request, state)
    expect(world.tokenRequests().length).toBe(tokensBefore + 1)
  })

  it('a read that gets 401 keeps the single retry', async () => {
    const { world, session } = await setup()
    world.backendStatus.set(PATH, 401)
    await errorOf(
      callBackend(new ApiClient(world.fetch), session, { workspaceId: WS_A, path: PATH }, { httpStatus: null })
    )
    expect(world.backendRequests()).toHaveLength(2)
  })

  describe('AC35: token refresh before a write', () => {
    async function withTokenLeft(seconds: number) {
      const context = await setup()
      context.world.backendRaw.set(PATH, () => json(200, {}))
      const api = new ApiClient(context.world.fetch)
      await callBackend(api, context.session, { workspaceId: WS_A, path: PATH }, { httpStatus: null })
      context.world.now += context.world.tokenTtl - seconds
      context.world.requests.length = 0
      return { ...context, api }
    }

    it('a write with 30 s left refreshes the token before the request', async () => {
      const { world, session, api } = await withTokenLeft(30)
      await callBackend(
        api,
        session,
        { workspaceId: WS_A, method: 'PATCH', path: PATH, body: {} },
        { httpStatus: null }
      )
      expect(world.requests.map((r) => (r.url.pathname.endsWith('/token') ? 'token' : r.method))).toEqual([
        'token',
        'PATCH'
      ])
    })

    it('a write with 60 s left uses the cached token', async () => {
      const { world, session, api } = await withTokenLeft(60)
      await callBackend(
        api,
        session,
        { workspaceId: WS_A, method: 'PATCH', path: PATH, body: {} },
        { httpStatus: null }
      )
      expect(world.tokenRequests()).toHaveLength(0)
    })

    it('a read with 30 s left uses the cached token', async () => {
      const { world, session, api } = await withTokenLeft(30)
      await callBackend(api, session, { workspaceId: WS_A, path: PATH }, { httpStatus: null })
      expect(world.tokenRequests()).toHaveLength(0)
    })
  })
})

describe('call log for generic calls (AC31, CONTRACT §7)', () => {
  const KEYS = [
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
  ]
  const input = {
    method: 'PUT',
    service: 's-events-resources',
    path: '/api/events/e1/resources/r1',
    query: { lang: 'en' },
    headers: { 'if-match': 'IFMATCHVALUE', Range: 'RANGEVALUE' },
    body: { secretField: 'BODYVALUE' }
  }

  it('writes exactly the §7 keys, no body and no header values', async () => {
    const { h, world } = await setup()
    world.backendRaw.set(PATH, () => json(200, { answer: 'RESPONSEVALUE' }))
    const result = await runApiTool(h.app, 'api_write', undefined, apiCallOf(input), async (ctx) => {
      const { session } = await openRealm(h.app, ctx, undefined)
      ctx.workspace = { id: WS_A, name: 'Alpha' }
      const checked = checkWrite(input.method, input, false)
      const response = await callBackend(
        h.app.api,
        session,
        { workspaceId: WS_A, method: checked.method, path: PATH, headers: checked.headers, body: input.body },
        ctx.state
      )
      return { status: response.status, body: response.body }
    })
    expect(result.isError).toBeUndefined()
    expect(h.logs).toHaveLength(1)
    const line = JSON.stringify(h.logs[0])
    expect(Object.keys(JSON.parse(line))).toEqual(KEYS)
    expect(JSON.parse(line)).toMatchObject({
      realm: 'default',
      user: 'frank',
      workspace: WS_A,
      tool: 'api_write',
      method: 'PUT',
      service: 's-events-resources',
      path: '/api/events/e1/resources/r1',
      query: { lang: 'en' },
      ifMatch: true,
      httpStatus: 200
    })
    for (const value of ['BODYVALUE', 'secretField', 'RESPONSEVALUE', 'IFMATCHVALUE', 'RANGEVALUE']) {
      expect(line).not.toContain(value)
    }
  })

  it('a policy refusal logs httpStatus null and sends nothing', async () => {
    const { h, world } = await setup()
    const call = apiCallOf({ method: 'DELETE', service: 's-events', path: '/api/events/e1' })
    const result = await runApiTool(h.app, 'api_write', undefined, call, async () => {
      checkWrite(call.method, call, false)
      return {}
    })
    expect(result.isError).toBe(true)
    expect(world.requests).toHaveLength(0)
    expect(h.logs[0]).toMatchObject({ method: 'DELETE', ifMatch: false, query: {}, httpStatus: null })
    expect(Object.keys(h.logs[0] ?? {})).toEqual(KEYS)
  })
})

describe('review fixes: HTTP', () => {
  it('body null sends no body and no Content-Type', async () => {
    const { client, calls } = stubClient(() => json(200, {}))
    await client.request('POST', 'h.example.com', PATH, 'tkn', {}, { body: null })
    expect(calls[0]?.init?.body).toBeUndefined()
    expect(calls[0]?.init?.headers).not.toHaveProperty('Content-Type')
  })

  it('JSON with a UTF-8 BOM is parsed', async () => {
    const { client } = stubClient(
      () => new Response('﻿{"a":1}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    )
    expect((await client.request('GET', 'h.example.com', PATH, 'tkn')).body).toEqual({ a: 1 })
  })

  const applied = (status: number, reason: string) =>
    `POST ${PATH} succeeded (${status}), but its response body is not returned: ${reason}. The change was applied: do not send it again. Read the object with api_get if you need it.`

  it.each([
    ['too large', () => json(201, 'x'.repeat(MAX_RESPONSE_BYTES + 10)), applied(201, 'it is larger than 500 KB')],
    [
      'not JSON',
      () => new Response('a,b', { status: 200, headers: { 'Content-Type': 'text/csv' } }),
      applied(200, 'it is text/csv, not JSON')
    ],
    [
      'invalid JSON',
      () => new Response('{"a":', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      applied(200, 'it is not valid JSON')
    ]
  ])('a 2xx write whose body is %s returns the status without a body', async (_name, response, note) => {
    const { client } = stubClient(response)
    const result = await client.request('POST', 'h.example.com', PATH, 'tkn', {}, { maxBytes: MAX_RESPONSE_BYTES })
    expect(result.body).toBeNull()
    expect(result.bodyNote).toBe(note)
    expect(result.status).toBeGreaterThanOrEqual(200)
  })

  it('a write without a response says the change may have been applied', async () => {
    const client = new ApiClient(async () => {
      throw new DOMException('timeout', 'TimeoutError')
    })
    expect(await errorOf(client.request('PATCH', 'h.example.com', PATH, 'tkn'))).toBe(
      `PATCH ${PATH} got no response (timeout or network error). The change may have been applied: read the object with api_get before you send it again.`
    )
  })

  it('httpStatus is recorded when the body of a 2xx read cannot be returned', async () => {
    const { world, session } = await setup()
    world.backendRaw.set(PATH, () => json(200, 'x'.repeat(MAX_RESPONSE_BYTES + 10)))
    const state: { httpStatus: number | null } = { httpStatus: null }
    await errorOf(
      callBackend(
        new ApiClient(world.fetch),
        session,
        { workspaceId: WS_A, path: PATH, maxBytes: MAX_RESPONSE_BYTES },
        state
      )
    )
    expect(state.httpStatus).toBe(200)
  })

  it('httpStatus is recorded for a write whose body is not returned', async () => {
    const { world, session } = await setup()
    world.backendRaw.set(PATH, () => new Response('a,b', { status: 201, headers: { 'Content-Type': 'text/csv' } }))
    const state: { httpStatus: number | null } = { httpStatus: null }
    const response = await callBackend(
      new ApiClient(world.fetch),
      session,
      { workspaceId: WS_A, method: 'POST', path: PATH, body: {} },
      state
    )
    expect(state.httpStatus).toBe(201)
    expect(response.bodyNote).toContain('The change was applied')
  })

  it('apiCallOf logs the method as it is sent', () => {
    expect(apiCallOf({ method: 'put', service: 's-events', path: '/api/x' }).method).toBe('PUT')
    expect(apiCallOf({ method: 'poſt', service: 's-events', path: '/api/x' }).method).toBe('poſt')
  })
})

describe('review fixes: workspace list', () => {
  it('an empty 200 is an error and is not cached', async () => {
    const { h, world } = await setup()
    world.backendRaw.set('/_gw/s-workspaces/api/workspaces', () => new Response(null, { status: 200 }))
    const first = await h.call('list_workspaces')
    expect(first.body.error).toBe('GET /_gw/s-workspaces/api/workspaces failed (200).')
    world.backendRaw.delete('/_gw/s-workspaces/api/workspaces')
    const second = await h.call('list_workspaces')
    expect(second.isError).toBe(false)
  })
})

describe('second opinion: log fields are picked, not spread', () => {
  it('extra fields on the call object never reach the log', async () => {
    const { h } = await setup()
    const wider = {
      ...apiCallOf({ method: 'POST', service: 's-events', path: '/api/events' }),
      body: { secretField: 'BODYVALUE' },
      headers: { 'If-Match': 'IFMATCHVALUE' }
    }
    await runApiTool(h.app, 'api_write', undefined, wider, async () => ({}))
    const line = JSON.stringify(h.logs[0])
    expect(Object.keys(h.logs[0] ?? {})).toEqual([
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
    expect(line).not.toContain('BODYVALUE')
    expect(line).not.toContain('IFMATCHVALUE')
  })
})

describe('write budget and concurrency cap', () => {
  it('refuses the write after 60 writes in one minute without sending it, and allows it again a minute later', async () => {
    let time = 0
    let sent = 0
    const client = new ApiClient(
      async () => {
        sent++
        return new Response(null, { status: 204 })
      },
      30_000,
      () => time
    )
    for (let i = 0; i < 60; i++) await client.request('PATCH', STAGE_HOST, PATH, 't')
    expect(await errorOf(client.request('PATCH', STAGE_HOST, PATH, 't'))).toContain('at most 60 writes per minute')
    expect(sent).toBe(60)
    await client.request('GET', STAGE_HOST, PATH, 't').catch(() => undefined)
    expect(sent).toBe(61)
    time = 60_001
    await client.request('PATCH', STAGE_HOST, PATH, 't')
    expect(sent).toBe(62)
  })

  it('keeps at most 4 requests in flight', async () => {
    let inFlight = 0
    let peak = 0
    const client = new ApiClient(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
      return json(200, { ok: true })
    })
    await Promise.all(Array.from({ length: 10 }, () => client.request('GET', STAGE_HOST, PATH, 't')))
    expect(peak).toBe(4)
  })
})
