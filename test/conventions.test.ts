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
  it('sends instructions that point to the conventions resource', async () => {
    const h = await setup()
    expect(h.client.getInstructions()).toContain('colada://conventions')
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
