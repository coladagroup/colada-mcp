import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, FakeWorld, type Harness, STAGE_HOST, WS_A, workspace } from './harness.js'

const SERVICE = 's-events-resources'
const PATH = '/api/events/e1/resources/r1'
const GW = `/_gw/${SERVICE}${PATH}`
const NO_REASON = 'The backend gave no reason.'

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

async function setup(status: number, body: string | null) {
  const world = new FakeWorld()
  world.addRealm(STAGE_HOST, { user: 'frank', members: [WS_A], workspaces: [workspace(WS_A, 'Alpha')] })
  const h = await createHarness(world)
  world.seedRefreshToken(STAGE_HOST, h.store)
  harnesses.push(h)
  world.backendRaw.set(GW, () => new Response(body, { status }))
  return h
}

async function errorText(h: Harness, tool: string): Promise<string> {
  if (tool === 'api_get') return (await h.call('api_get', { workspace: WS_A, service: SERVICE, path: PATH })).body.error
  const write = { method: 'PUT', service: SERVICE, path: PATH, headers: { 'If-Match': '1' }, body: { title: 'T' } }
  if (tool === 'api_write') return (await h.call('api_write', { workspace: WS_A, ...write })).body.error
  const batch = await h.call('api_write_batch', { workspace: WS_A, items: [write] })
  return (batch.body.items as Array<{ error: string }>)[0]?.error ?? ''
}

describe('empty backend bodies (S12, AC-7.10)', () => {
  it.each([
    ['api_get', 400],
    ['api_get', 500],
    ['api_write', 400],
    ['api_write', 500],
    ['api_write_batch', 400],
    ['api_write_batch', 500]
  ])('%s with an empty %i says the backend gave no reason', async (tool, status) => {
    const h = await setup(status, null)
    const text = await errorText(h, tool)
    expect(text).toContain(`(${status})`)
    expect(text).toContain(NO_REASON)
  })

  it.each(['api_get', 'api_write', 'api_write_batch'])('%s with a body still shows the service text', async (tool) => {
    const h = await setup(400, 'title is required')
    const text = await errorText(h, tool)
    expect(text).toContain('The service said: title is required')
    expect(text).not.toContain(NO_REASON)
  })
})
