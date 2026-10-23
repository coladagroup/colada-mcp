import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, FakeWorld, type Harness, STAGE_HOST, WS_A, workspace } from './harness.js'

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

async function setup() {
  const world = new FakeWorld()
  world.addRealm(STAGE_HOST, { user: 'frank', members: [WS_A], workspaces: [workspace(WS_A, 'Alpha')] })
  const h = await createHarness(world, [STAGE_HOST])
  harnesses.push(h)
  return h
}

describe('server instructions and conventions', () => {
  it('sends instructions that ask for get_conventions before a write', async () => {
    const h = await setup()
    expect(h.client.getInstructions()).toContain('get_conventions before the first api_write')
  })

  it('get_conventions returns the same text as the resource without a backend call', async () => {
    const h = await setup()
    const tool = await h.client.callTool({ name: 'get_conventions', arguments: {} })
    const read = await h.client.readResource({ uri: 'colada://conventions' })
    expect(JSON.stringify(tool.content)).toContain('# Colada backoffice API conventions')
    expect((tool.content as Array<{ text: string }>)[0]?.text).toBe((read.contents[0] as { text: string }).text)
    expect(h.world.backendRequests()).toEqual([])
  })

  it('serves the conventions resource without a backend call', async () => {
    const h = await setup()
    const { resources } = await h.client.listResources()
    expect(resources.map((r) => r.uri)).toEqual(['colada://conventions'])
    const read = await h.client.readResource({ uri: 'colada://conventions' })
    expect(JSON.stringify(read.contents)).toContain('# Colada backoffice API conventions')
    expect(h.world.backendRequests()).toEqual([])
  })
})
