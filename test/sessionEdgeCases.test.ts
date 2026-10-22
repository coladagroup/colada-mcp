import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createHarness,
  EVENT_A,
  EVENT_B,
  eventPath,
  FakeStore,
  FakeWorld,
  type Harness,
  WS_A,
  WS_B,
  WS_FOREIGN,
  workspace
} from './harness.js'

const STAGE = 'stage-admin.colada365.com'
const CLIENT = 'client.example.com'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const harnesses: Harness[] = []
const uncaught: unknown[] = []
const onUncaught = (err: unknown) => uncaught.push(err)
process.on('uncaughtException', onUncaught)

function stageWorld() {
  const world = new FakeWorld()
  world.addRealm(STAGE, {
    user: 'frank',
    members: [WS_A, WS_B],
    workspaces: [workspace(WS_A, 'Alpha'), workspace(WS_B, 'Beta')]
  })
  world.events.set(WS_A, new Map([[EVENT_A, { uid: EVENT_A, title: 'Gala A' }]]))
  world.events.set(WS_B, new Map([[EVENT_B, { uid: EVENT_B, title: 'Gala B' }]]))
  return world
}

async function harness(world: FakeWorld, options: { hosts?: string[]; loggedIn?: boolean; store?: FakeStore } = {}) {
  const store = options.store ?? new FakeStore()
  if (options.loggedIn !== false && !store.values.has(STAGE) && world.realms.has(STAGE)) {
    world.seedRefreshToken(STAGE, store)
  }
  const h = await createHarness(world, options.hosts, store)
  harnesses.push(h)
  return h
}

function callbackUrl(loginUrl: string) {
  const auth = new URL(loginUrl)
  const state = encodeURIComponent(auth.searchParams.get('state') ?? '')
  return `${auth.searchParams.get('redirect_uri')}/?state=${state}&code=test-code`
}

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
  uncaught.length = 0
})

describe('login state', () => {
  it('a login that finishes before the browser launcher returns does not crash and does not block the realm', async () => {
    const h = await harness(stageWorld(), { loggedIn: false })
    h.hooks.onOpen = async (url) => {
      const page = await fetch(callbackUrl(url))
      await page.text()
      await sleep(10)
    }

    await h.call('list_workspaces')
    await sleep(20)
    const retry = await h.call('list_workspaces')

    expect(uncaught).toEqual([])
    expect(retry.isError).toBe(false)
  })

  it('two calls that both end the session start one login only', async () => {
    const world = stageWorld()
    const h = await harness(world)
    world.backendStatus.set(`/_gw/s-events/api/events/${EVENT_A}`, 401)
    world.backendStatus.set(`/_gw/s-events/api/events/${EVENT_B}`, 401)

    await Promise.all([
      h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) }),
      h.call('api_get', { workspace: WS_B, ...eventPath(EVENT_B) })
    ])
    expect(h.opened).toHaveLength(1)

    world.backendStatus.clear()
    await h.completeLogin()
    const retry = await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
    expect(retry.isError).toBe(false)
  })

  it('the realm is not blocked when the browser drops the callback connection during the code exchange', async () => {
    const world = stageWorld()
    const h = await harness(world, { loggedIn: false })
    await h.call('list_workspaces')
    world.tokenDelayMs = 60

    const req = request(callbackUrl(h.opened[0] ?? ''))
    req.on('error', () => undefined)
    req.end()
    await sleep(15)
    req.destroy()
    await sleep(100)
    world.tokenDelayMs = 0

    const retry = await h.call('list_workspaces')
    expect(retry.isError).toBe(false)
  })
})

describe('logout races', () => {
  it('a token request that finishes after logout does not bring the session back', async () => {
    const world = stageWorld()
    const h = await harness(world)
    world.tokenDelayMs = 40

    const running = h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
    await sleep(10)
    await h.call('logout')
    await running
    world.tokenDelayMs = 0

    expect(h.store.values.has(STAGE)).toBe(false)
    const next = await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
    expect(next.body.error).toMatch(/^Login opened in your browser/)
  })

  it('a code exchange that finishes after logout does not store the session', async () => {
    const world = stageWorld()
    const h = await harness(world, { loggedIn: false })
    await h.call('list_workspaces')
    world.tokenDelayMs = 40

    const callback = fetch(callbackUrl(h.opened[0] ?? '')).then((r) => r.text())
    await sleep(10)
    await h.call('logout')
    await callback
    world.tokenDelayMs = 0

    expect(h.store.values.has(STAGE)).toBe(false)
    const next = await h.call('list_workspaces')
    expect(next.body.error).toMatch(/^Login opened in your browser/)
  })
})

describe('refresh token from another process', () => {
  it('invalid_grant after another process rotated the token retries with the new token and keeps it', async () => {
    const world = new FakeWorld()
    world.addRealm(CLIENT, {
      name: 'client',
      user: 'frank-client',
      homeWorkspace: WS_FOREIGN,
      rotation: true,
      workspaces: [workspace(WS_FOREIGN, 'Client WS', 'client')]
    })
    world.addRealm('admin.colada365.com', { user: 'frank' })
    const store = new FakeStore()
    world.seedRefreshToken(CLIENT, store)
    const first = await harness(world, { hosts: ['admin.colada365.com', CLIENT], store })
    const second = await harness(world, { hosts: ['admin.colada365.com', CLIENT], store })
    const original = world.fetch
    ;(second.app.deps as { fetch: typeof fetch }).fetch = async (input, init) => {
      if (String(input).endsWith('/token')) await sleep(30)
      return original(input, init)
    }
    world.tokenDelayMs = 10

    const [a, b] = await Promise.all([
      first.call('list_workspaces', { realm: 'client' }),
      second.call('list_workspaces', { realm: 'client' })
    ])

    expect([a.isError, b.isError]).toEqual([false, false])
    expect(second.opened).toHaveLength(0)
    const stored = store.values.get(CLIENT) ?? ''
    expect(world.realms.get(CLIENT)?.validRefreshTokens.has(stored)).toBe(true)
  })
})

describe('keyring entry removed outside this process', () => {
  it('drops cached tokens and the workspace list before the new login', async () => {
    const world = stageWorld()
    const h = await harness(world)
    await h.call('api_get', { workspace: 'Alpha', ...eventPath(EVENT_A) })
    h.store.values.delete(STAGE)

    const login = await h.call('api_get', { workspace: WS_B, ...eventPath(EVENT_B) })
    expect(login.body.error).toMatch(/^Login opened in your browser/)
    const realm = world.realms.get(STAGE)
    if (realm) realm.user = 'bob'
    await h.completeLogin()

    const tokenRequestsBefore = world.tokenRequests().length
    const listRequestsBefore = world.backendRequests().filter((r) => r.url.pathname.endsWith('/workspaces')).length
    const result = await h.call('api_get', { workspace: 'Alpha', ...eventPath(EVENT_A) })

    expect(result.body.user).toBe('bob')
    expect(world.tokenRequests().length).toBe(tokenRequestsBefore + 1)
    expect(world.backendRequests().filter((r) => r.url.pathname.endsWith('/workspaces')).length).toBe(
      listRequestsBefore + 1
    )
  })
})

describe('backend responses', () => {
  it('a 2xx answer with a broken JSON body is an error, not null data', async () => {
    const world = stageWorld()
    const h = await harness(world)
    world.backendRaw.set(
      `/_gw/s-events/api/events/${EVENT_A}`,
      () => new Response('{"uid":', { status: 200, headers: { 'Content-Type': 'application/json' } })
    )
    const result = await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
    expect(result.isError).toBe(true)
    expect(result.body.error).toBe(`GET /_gw/s-events/api/events/${EVENT_A} returned invalid JSON (200).`)
  })

  it('a 2xx answer whose body stream fails is an error', async () => {
    const world = stageWorld()
    const h = await harness(world)
    world.backendRaw.set(
      '/_gw/s-workspaces/api/workspaces',
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('[{"id":'))
              controller.error(new Error('socket reset'))
            }
          }),
          { status: 200 }
        )
    )
    const result = await h.call('list_workspaces')
    expect(result.body.error).toBe('GET /_gw/s-workspaces/api/workspaces failed (no response).')
  })

  it('every token and backend request refuses redirects', async () => {
    const h = await harness(stageWorld(), { loggedIn: false })
    await h.call('list_workspaces')
    await h.completeLogin()
    await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
    expect(h.world.requests.length).toBeGreaterThan(2)
    for (const r of h.world.requests) expect(r.redirect).toBe('error')
  })
})

describe('inputs', () => {
  it('an empty realm means the main realm in every tool', async () => {
    const world = stageWorld()
    world.addRealm(CLIENT, { name: 'client', user: 'frank-client' })
    const h = await harness(world, { hosts: [STAGE, CLIENT] })
    const event = await h.call('api_get', { realm: '', workspace: WS_A, ...eventPath(EVENT_A) })
    expect(event.body).toMatchObject({ realm: 'default', body: { uid: EVENT_A } })
    const logout = await h.call('logout', { realm: '' })
    expect(logout.body).toMatchObject({ realm: null, message: 'Logged out from all realms.' })
  })

  it('an unknown name in a fresh process fetches the workspace list once', async () => {
    const h = await harness(stageWorld())
    await h.call('api_get', { workspace: 'Nope', ...eventPath(EVENT_A) })
    expect(h.world.backendRequests().filter((r) => r.url.pathname.endsWith('/workspaces'))).toHaveLength(1)
  })

  it('the login message always contains the login URL', async () => {
    const h = await harness(stageWorld(), { loggedIn: false })
    const result = await h.call('list_workspaces')
    expect(result.body.error).toBe(
      `Login opened in your browser for realm default on ${STAGE}. Finish it, then call the tool again. If no browser tab opened, open this URL: ${h.opened[0]}`
    )
  })
})
