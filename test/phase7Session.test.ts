import { afterEach, describe, expect, it } from 'vitest'
import { parseNoBrowser } from '../src/config.js'
import { version } from '../src/version.js'
import { createHarness, FakeStore, FakeWorld, type Harness, STAGE_HOST, WS_A, workspace } from './harness.js'

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

async function setup(options: { loggedIn?: boolean; ssoEndsIn?: number; noBrowser?: boolean } = {}) {
  const world = new FakeWorld()
  world.addRealm(STAGE_HOST, { user: 'frank', members: [WS_A], workspaces: [workspace(WS_A, 'Alpha')] })
  if (options.ssoEndsIn !== undefined) world.ssoEndsAt = world.now + options.ssoEndsIn
  const store = new FakeStore()
  if (options.loggedIn !== false) world.seedRefreshToken(STAGE_HOST, store)
  const h = await createHarness(world, [STAGE_HOST], store, false, { noBrowser: options.noBrowser })
  harnesses.push(h)
  return h
}

async function signIn(h: Harness) {
  await h.call('list_workspaces')
  await h.completeLogin()
  return h.call('list_workspaces')
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

describe('short session note (S1, AC-7.1)', () => {
  it('a sign-in with 34,199 s left gives sessionNote with the end time', async () => {
    const h = await setup({ loggedIn: false, ssoEndsIn: 34_199 })
    const endsAt = h.world.now + 34_199
    const result = await signIn(h)
    expect(result.body.sessionEndsAt).toBe(iso(endsAt))
    expect(result.body.sessionNote).toBe(
      `This Colada session ends at ${iso(endsAt)} because it reuses your browser sign-in (10 h limit). For a full 10 h: sign out of the backoffice in the browser, call logout, then sign in again.`
    )
  })

  it('a sign-in with 34,200 s left gives no sessionNote', async () => {
    const h = await setup({ loggedIn: false, ssoEndsIn: 34_200 })
    const result = await signIn(h)
    expect(result.body.sessionNote).toBeUndefined()
  })

  it('a refresh with a short lifetime never sets the note', async () => {
    const h = await setup({ ssoEndsIn: 3600 })
    const result = await h.call('list_workspaces')
    expect(result.body.sessionEndsAt).toBe(iso(h.world.now + 3600))
    expect(result.body.sessionNote).toBeUndefined()
  })

  it('logout clears the note, and a later full sign-in gives none', async () => {
    const h = await setup({ loggedIn: false, ssoEndsIn: 20_000 })
    expect((await signIn(h)).body.sessionNote).toBeDefined()
    await h.call('logout')
    h.world.ssoEndsAt = h.world.now + 36_000
    const result = await signIn(h)
    expect(result.body.sessionNote).toBeUndefined()
  })
})

describe('COLADA_NO_BROWSER (S2, AC-7.2)', () => {
  it('parses only "1"', () => {
    expect(parseNoBrowser({ COLADA_NO_BROWSER: '1' })).toBe(true)
    expect(parseNoBrowser({ COLADA_NO_BROWSER: 'true' })).toBe(true)
    expect(parseNoBrowser({ COLADA_NO_BROWSER: '0' })).toBe(false)
    expect(parseNoBrowser({})).toBe(false)
  })

  it('without a refresh token every call answers login_required at once, opens nothing and starts no login', async () => {
    const h = await setup({ loggedIn: false, noBrowser: true })
    const started = Date.now()
    const first = await h.call('list_workspaces')
    const second = await h.call('api_get', { workspace: WS_A, service: 's-events', path: '/api/events' })
    expect(Date.now() - started).toBeLessThan(2000)
    for (const answer of [first, second]) {
      expect(answer.isError).toBe(true)
      expect(answer.text).toContain(
        'Colada sign-in needed; this server runs without a browser. Sign in from an interactive session first.'
      )
    }
    expect(h.opened).toEqual([])
    expect(h.logs.map((entry) => entry.outcome)).toEqual(['login_required', 'login_required'])
  })

  it('an expired refresh token also answers login_required without a browser', async () => {
    const h = await setup({ noBrowser: true })
    h.store.values.set(STAGE_HOST, 'refresh-revoked')
    const answer = await h.call('list_workspaces')
    expect(answer.isError).toBe(true)
    expect(answer.text).toContain('this server runs without a browser')
    expect(h.opened).toEqual([])
  })

  it('the end-of-session notice does not promise a browser login', async () => {
    const h = await setup({ noBrowser: true, ssoEndsIn: 3600 })
    await h.call('list_workspaces')
    const endsAt = h.world.now + 3600
    h.world.now = endsAt - 29 * 60
    expect((await h.call('list_workspaces')).body.notice).toBe(
      `Your Colada login ends at ${iso(endsAt)} (in about 29 min). After that every call answers login_required, because this server runs without a browser. Finish open writes first.`
    )
  })

  it('logout warns that this server cannot sign in again', async () => {
    const h = await setup({ noBrowser: true })
    const answer = await h.call('logout')
    expect(answer.isError).toBe(false)
    expect(answer.body.message).toContain('This server runs without a browser, so it cannot sign in again')
  })

  it('a valid stored refresh token still works', async () => {
    const h = await setup({ noBrowser: true })
    const answer = await h.call('list_workspaces')
    expect(answer.isError).toBe(false)
    expect(answer.body.workspaces).toHaveLength(1)
  })
})

describe('server version (S3)', () => {
  it('list_workspaces returns the package version', async () => {
    const h = await setup()
    expect((await h.call('list_workspaces')).body.version).toBe(version)
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('workspace errors (S11, AC-7.9)', () => {
  const ids = Array.from({ length: 59 }, (_, i) => `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, '0')}`)
  const names = ids.map((_, i) => (i < 12 ? `Event Agency ${i}` : `Client ${i}`))

  async function many() {
    const world = new FakeWorld()
    world.addRealm(STAGE_HOST, {
      user: 'frank',
      members: ids,
      workspaces: ids.map((id, i) => workspace(id, names[i] as string))
    })
    const store = new FakeStore()
    world.seedRefreshToken(STAGE_HOST, store)
    const h = await createHarness(world, [STAGE_HOST], store)
    harnesses.push(h)
    await h.call('list_workspaces')
    return h
  }

  const listed = (text: string) => (text.match(/aaaaaaaa-0000-0000-0000-\d{12} — /g) ?? []).length

  it('an unknown name shows at most 10 close matches and points to list_workspaces', async () => {
    const h = await many()
    const answer = await h.call('api_get', { workspace: 'agency', service: 's-events', path: '/api/events' })
    expect(answer.isError).toBe(true)
    expect(answer.body.error).toMatch(/^The "workspace" parameter "agency" matches no workspace\. Close matches:\n/)
    expect(listed(String(answer.body.error))).toBe(10)
    expect(answer.body.error).toContain('… and 2 more.')
    expect(answer.body.error).toContain('Call list_workspaces for the full list.')
    expect(answer.body.error).not.toContain('Client ')
  })

  it('a name shared by more than 10 workspaces points to list_workspaces', async () => {
    const world = new FakeWorld()
    const same = ids.slice(0, 12)
    world.addRealm(STAGE_HOST, { user: 'frank', members: same, workspaces: same.map((id) => workspace(id, 'Same')) })
    const store = new FakeStore()
    world.seedRefreshToken(STAGE_HOST, store)
    const h = await createHarness(world, [STAGE_HOST], store)
    harnesses.push(h)
    const answer = await h.call('api_get', { workspace: 'Same', service: 's-events', path: '/api/events' })
    expect(answer.body.error).toContain('… and 2 more.')
    expect(answer.body.error).toContain('Call list_workspaces for the full list.')
  })

  it('a missing workspace lists no workspace at all', async () => {
    const h = await many()
    const answer = await h.call('api_get', { service: 's-events', path: '/api/events' })
    expect(answer.body.error).toBe(
      'Pass the "workspace" parameter: you have 59 workspaces. Call list_workspaces for the full list.'
    )
  })
})
