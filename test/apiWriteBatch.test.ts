import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, FakeWorld, type Harness, json, STAGE_HOST, WS_A, WS_B, workspace } from './harness.js'

const SERVICE = 's-events-resources'
const resource = (n: number) => `/api/events/e1/resources/r${n}`
const gw = (n: number) => `/_gw/${SERVICE}${resource(n)}`

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

async function setup() {
  const world = new FakeWorld()
  world.addRealm(STAGE_HOST, {
    user: 'frank',
    members: [WS_A, WS_B],
    workspaces: [workspace(WS_A, 'Alpha'), workspace(WS_B, 'Beta')]
  })
  const h = await createHarness(world)
  world.seedRefreshToken(STAGE_HOST, h.store)
  harnesses.push(h)
  for (let n = 1; n <= 5; n++) {
    world.backendRaw.set(gw(n), () => json(200, { id: `r${n}` }, { 'X-ETag': String(n + 1) }))
  }
  return h
}

const item = (n: number, extra: Record<string, unknown> = {}) => ({
  method: 'PUT',
  service: SERVICE,
  path: resource(n),
  headers: { 'If-Match': String(n) },
  body: { title: `Title ${n}` },
  ...extra
})
const FIVE = [1, 2, 3, 4, 5].map((n) => item(n))

const sent = (h: Harness) =>
  h.world.backendRequests().filter((request) => request.url.pathname.startsWith(`/_gw/${SERVICE}/`))
const batchLines = (h: Harness) => h.logs.filter((line) => line.tool === 'api_write_batch')

describe('api_write_batch (AC-6.5)', () => {
  it('sends all items in order with one log line each', async () => {
    const h = await setup()
    const result = await h.call('api_write_batch', { workspace: WS_A, items: FIVE })

    expect(result.isError).toBe(false)
    expect(result.body.done).toBe(5)
    expect((result.body.items as unknown[])[0]).toEqual({
      item: 1,
      result: 'done',
      status: 200,
      headers: { 'X-ETag': '2' }
    })
    expect(sent(h).map((request) => [request.method, request.url.pathname, request.headers['if-match']])).toEqual(
      [1, 2, 3, 4, 5].map((n) => ['PUT', gw(n), String(n)])
    )
    expect(batchLines(h).map((line) => [line.outcome, line.httpStatus, 'path' in line ? line.path : null])).toEqual(
      [1, 2, 3, 4, 5].map((n) => ['ok', 200, resource(n)])
    )
    expect(JSON.stringify(h.logs)).not.toContain('Title')
  })

  it('item 3 of 5 refused by the policy: nothing is sent, the error names item 3', async () => {
    const h = await setup()
    const items = [...FIVE]
    items[2] = { method: 'DELETE', service: 's-events', path: '/api/events/e1' } as never
    const result = await h.call('api_write_batch', { workspace: WS_A, items })

    expect(result.isError).toBe(true)
    expect(result.body.error).toMatch(/^Item 3: .*Nothing was sent\.$/)
    expect(h.world.backendRequests()).toEqual([])
    const lines = batchLines(h)
    expect(lines).toHaveLength(5)
    expect(lines.every((line) => line.outcome === 'refused' && line.httpStatus === null)).toBe(true)
  })

  it('item 3 of 5 fails at the backend: 1–2 done, 3 failed with status, 4–5 not run', async () => {
    const h = await setup()
    h.world.backendRaw.set(gw(3), () => json(409, { message: 'stale revision' }))
    const result = await h.call('api_write_batch', { workspace: WS_A, items: FIVE })

    expect(result.isError).toBe(false)
    expect(result.body.done).toBe(2)
    expect((result.body.items as Array<{ result: string }>).map((entry) => entry.result)).toEqual([
      'done',
      'done',
      'failed',
      'not run',
      'not run'
    ])
    expect((result.body.items as unknown[])[2]).toMatchObject({
      item: 3,
      status: 409,
      error: expect.stringContaining('409')
    })
    expect(sent(h).map((request) => request.url.pathname)).toEqual([gw(1), gw(2), gw(3)])
    expect(batchLines(h).map((line) => [line.outcome, line.reason, line.httpStatus])).toEqual([
      ['ok', null, 200],
      ['ok', null, 200],
      ['conflict', 'conflict', 409],
      ['refused', 'notRun', null],
      ['refused', 'notRun', null]
    ])
  })

  it('the schema refuses 0 and 26 items', async () => {
    const h = await setup()
    for (const items of [[], Array.from({ length: 26 }, () => item(1))]) {
      const result = await h.client.callTool({ name: 'api_write_batch', arguments: { workspace: WS_A, items } })
      expect(result.isError).toBe(true)
    }
    const max = await h.call('api_write_batch', { workspace: WS_A, items: Array.from({ length: 25 }, () => item(1)) })
    expect(max.isError).toBe(false)
    expect(sent(h)).toHaveLength(25)
  })

  it('with 50 writes in the last minute a 20-item batch is refused before any request', async () => {
    const h = await setup()
    for (let i = 0; i < 50; i++) await h.call('api_write', { workspace: WS_A, ...item(1) })
    expect(sent(h)).toHaveLength(50)

    const result = await h.call('api_write_batch', {
      workspace: WS_A,
      items: Array.from({ length: 20 }, () => item(2))
    })
    expect(result.isError).toBe(true)
    expect(result.body.error).toContain('only 10 of 60 writes per minute are left')
    expect(sent(h)).toHaveLength(50)
    expect(batchLines(h).every((line) => line.reason === 'batchBudget')).toBe(true)

    const fits = await h.call('api_write_batch', { workspace: WS_A, items: Array.from({ length: 10 }, () => item(2)) })
    expect(fits.body.done).toBe(10)
  })
})

describe('api_write_batch preview (AC-6.6)', () => {
  it('sends nothing and returns per item the request a real batch sends', async () => {
    const h = await setup()
    const items = FIVE.map((entry, index) => ({ ...entry, query: { n: String(index) } }))
    const preview = await h.call('api_write_batch', { workspace: WS_A, items, preview: true })

    expect(preview.isError).toBe(false)
    expect(sent(h)).toEqual([])
    expect(batchLines(h).map((line) => [line.outcome, line.httpStatus])).toEqual(Array(5).fill(['preview', null]))

    await h.call('api_write_batch', { workspace: WS_A, items })
    expect(preview.body.items).toEqual(
      sent(h).map((request, index) => ({
        item: index + 1,
        request: {
          method: request.method,
          host: request.url.host,
          service: SERVICE,
          path: resource(index + 1),
          query: Object.fromEntries(request.url.searchParams),
          headers: ['If-Match'],
          body: JSON.parse(String(request.body))
        }
      }))
    )
  })

  it('a policy-refused item shows its refusal; the other items show their request', async () => {
    const h = await setup()
    const items = [...FIVE]
    items[2] = { method: 'DELETE', service: 's-events', path: '/api/events/e1' } as never
    const preview = await h.call('api_write_batch', { workspace: WS_A, items, preview: true })

    expect(preview.isError).toBe(false)
    expect(sent(h)).toEqual([])
    expect((preview.body.items as unknown[])[2]).toEqual({ item: 3, refused: expect.stringContaining('DELETE') })
    expect((preview.body.items as Array<{ request: { path: string } }>)[1]?.request.path).toBe(resource(2))
    expect(batchLines(h).map((line) => line.outcome)).toEqual(['preview', 'preview', 'refused', 'preview', 'preview'])
  })
})
