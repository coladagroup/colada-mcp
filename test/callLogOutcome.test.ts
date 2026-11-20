import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, FakeStore, FakeWorld, type Harness, STAGE_HOST, WS_A, workspace } from './harness.js'

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

async function setup(loggedIn = true) {
  const world = new FakeWorld()
  world.addRealm(STAGE_HOST, { user: 'frank', members: [WS_A], workspaces: [workspace(WS_A, 'Alpha')] })
  const store = new FakeStore()
  if (loggedIn) world.seedRefreshToken(STAGE_HOST, store)
  const h = await createHarness(world, [STAGE_HOST], store)
  harnesses.push(h)
  return h
}

describe('call log outcome, reason, pid and client (AC-6.3)', () => {
  it('a call that opens the login logs outcome login_required', async () => {
    const h = await setup(false)
    await h.call('list_workspaces')

    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toMatchObject({ tool: 'list_workspaces', outcome: 'login_required', reason: 'loginOpened' })
  })

  it('every line has outcome, reason, pid and the client name from initialize', async () => {
    const h = await setup()
    await h.call('list_workspaces')
    await h.client.callTool({ name: 'get_conventions', arguments: {} })
    await h.call('api_get', { workspace: WS_A, service: 'S-EVENTS', path: '/api/events' })

    expect(h.logs.map((line) => [line.tool, line.outcome, line.reason, line.pid, line.client])).toEqual([
      ['list_workspaces', 'ok', null, 4242, 'test'],
      ['get_conventions', 'ok', null, 4242, 'test'],
      ['api_get', 'refused', 'serviceNotAllowed', 4242, 'test']
    ])
  })

  it('get_conventions writes one line and still answers with the markdown text', async () => {
    const h = await setup()
    const result = await h.client.callTool({ name: 'get_conventions', arguments: {} })

    expect(JSON.stringify(result.content)).toContain('## Campaigns data')
    expect(result.isError).toBeFalsy()
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0]).toMatchObject({ tool: 'get_conventions', params: {}, httpStatus: null, outcome: 'ok' })
  })
})
