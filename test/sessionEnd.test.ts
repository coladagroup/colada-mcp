import { afterEach, describe, expect, it } from 'vitest'
import { RealmSession } from '../src/auth/session.js'
import { createHarness, FakeStore, FakeWorld, type Harness, jwt, STAGE_HOST, WS_A, workspace } from './harness.js'

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

async function setup(options: { loggedIn?: boolean; ssoEndsIn?: number | null } = {}) {
  const world = new FakeWorld()
  world.addRealm(STAGE_HOST, { user: 'frank', members: [WS_A], workspaces: [workspace(WS_A, 'Alpha')] })
  if (options.ssoEndsIn !== undefined)
    world.ssoEndsAt = options.ssoEndsIn === null ? null : world.now + options.ssoEndsIn
  const store = new FakeStore()
  if (options.loggedIn !== false) world.seedRefreshToken(STAGE_HOST, store)
  const h = await createHarness(world, [STAGE_HOST], store)
  harnesses.push(h)
  return h
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

describe('session end time (AC-6.4, Q28)', () => {
  it('list_workspaces returns sessionEndsAt from refresh_expires_in', async () => {
    const h = await setup({ ssoEndsIn: 9 * 3600 })
    const result = await h.call('list_workspaces')
    expect(result.body.sessionEndsAt).toBe(iso(h.world.now + 9 * 3600))
    expect(result.body.notice).toBeUndefined()
  })

  it('every answer carries the notice in the last 30 minutes, none 31 minutes before', async () => {
    const h = await setup({ ssoEndsIn: 3600 })
    await h.call('list_workspaces')
    const endsAt = h.world.now + 3600

    h.world.now = endsAt - 31 * 60
    expect((await h.call('list_workspaces')).body.notice).toBeUndefined()

    h.world.now = endsAt - 29 * 60
    const listed = await h.call('list_workspaces')
    const refused = await h.call('api_get', { workspace: WS_A, service: 'S-EVENTS', path: '/api/events' })
    for (const answer of [listed, refused]) {
      expect(answer.body.notice).toBe(
        `Your Colada login ends at ${iso(endsAt)} (in about 29 min). After that the next call opens the browser login. Finish open writes first.`
      )
    }
  })

  it.each([
    ['missing', null],
    ['0', 0]
  ])('refresh_expires_in %s means unknown: no sessionEndsAt, no notice', async (_name, ssoEndsIn) => {
    const h = await setup({ ssoEndsIn })
    const result = await h.call('list_workspaces')
    expect(result.body.sessionEndsAt).toBeNull()
    h.world.now += 60
    expect((await h.call('list_workspaces')).body.notice).toBeUndefined()
  })

  it('the keyring keeps the raw refresh token after a login', async () => {
    const h = await setup({ loggedIn: false })
    await h.call('list_workspaces')
    await h.completeLogin()
    const stored = h.store.values.get(STAGE_HOST)
    const issued = h.world.issued.filter((value) => value.startsWith('refresh-'))
    expect(stored).toBe(issued.at(-1))
  })
})

describe('session end time after a restart, before any token response (Q28)', () => {
  const deps = (store: FakeStore) => ({
    store,
    now: () => 1_800_000_000,
    fetch: globalThis.fetch,
    openBrowser: async () => undefined,
    log: () => undefined
  })

  it('takes exp of a JWT-shaped stored refresh token', async () => {
    const store = new FakeStore()
    store.values.set(STAGE_HOST, jwt({ exp: 1_800_020_000, typ: 'Refresh' }))
    expect(await new RealmSession('default', STAGE_HOST, deps(store)).sessionEndsAt()).toBe(1_800_020_000)
  })

  it('is unknown for a stored token that is not a JWT, and when nothing is stored', async () => {
    const store = new FakeStore()
    store.values.set(STAGE_HOST, 'opaque-refresh-token')
    expect(await new RealmSession('default', STAGE_HOST, deps(store)).sessionEndsAt()).toBeNull()
    expect(await new RealmSession('default', STAGE_HOST, deps(new FakeStore())).sessionEndsAt()).toBeNull()
  })
})
