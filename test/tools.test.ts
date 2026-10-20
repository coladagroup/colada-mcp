import { afterEach, describe, expect, it } from 'vitest'
import {
  claimsOf,
  createHarness,
  EVENT_A,
  EVENT_B,
  FakeStore,
  FakeWorld,
  type Harness,
  WS_A,
  WS_B,
  WS_FOREIGN,
  workspace
} from './harness.js'

const STAGE = 'stage-admin.colada365.com'
const PROD = 'admin.colada365.com'
const LIDL = 'lidl-football-hub.com'

const harnesses: Harness[] = []

async function setup(
  options: { env?: 'stage' | 'prod'; loggedIn?: boolean; world?: FakeWorld; store?: FakeStore } = {}
) {
  const env = options.env ?? 'stage'
  const host = env === 'stage' ? STAGE : PROD
  const world = options.world ?? new FakeWorld()
  if (!world.realms.has(host)) {
    world.addRealm(host, {
      user: 'frank',
      members: [WS_A, WS_B],
      workspaces: [workspace(WS_A, 'Alpha'), workspace(WS_B, 'Beta'), workspace(WS_FOREIGN, 'Lidl WS', 'lidl')]
    })
  }
  world.events.set(WS_A, new Map([[EVENT_A, { uid: EVENT_A, title: 'Gala A', nested: { x: [1, 2] } }]]))
  world.events.set(WS_B, new Map([[EVENT_B, { uid: EVENT_B, title: 'Gala B' }]]))
  const store = options.store ?? new FakeStore()
  if (options.loggedIn !== false && !store.values.has(host)) world.seedRefreshToken(host, store)
  const harness = await createHarness(world, env, store)
  harnesses.push(harness)
  return harness
}

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

describe('login and session', () => {
  it('AC1: no session opens the login, returns the retry message and sends no backend call', async () => {
    const h = await setup({ loggedIn: false })
    const result = await h.call('list_workspaces')

    expect(result.isError).toBe(true)
    expect(result.body.error).toBe(
      `Login opened in your browser for realm default on ${STAGE}. Finish it, then call the tool again.`
    )
    expect(h.opened).toHaveLength(1)
    const url = new URL(h.opened[0] ?? '')
    expect(url.origin + url.pathname).toBe(`https://${STAGE}/auth/realms/default/protocol/openid-connect/auth`)
    expect(url.searchParams.get('client_id')).toBe('colada-mcp')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(h.world.backendRequests()).toHaveLength(0)
    expect(h.logs[0]?.httpStatus).toBeNull()
  })

  it('AC1: a second call during the login opens no new tab', async () => {
    const h = await setup({ loggedIn: false })
    await h.call('list_workspaces')
    const second = await h.call('get_event', { workspace: WS_A, eventId: EVENT_A })

    expect(second.body.error).toBe('Login is in progress in your browser. Finish it, then call the tool again.')
    expect(h.opened).toHaveLength(1)
  })

  it('AC1: after the browser login the retried call works and the refresh token is stored', async () => {
    const h = await setup({ loggedIn: false })
    await h.call('list_workspaces')
    const page = await h.completeLogin()
    expect(await page.text()).toContain('Login done')

    const exchange = h.world.tokenRequests().at(-1)
    expect(exchange?.form?.get('grant_type')).toBe('authorization_code')
    expect(exchange?.form?.get('code_verifier')).toBeTruthy()
    expect(exchange?.form?.get('redirect_uri')).toBe(new URL(h.opened[0] ?? '').searchParams.get('redirect_uri'))
    expect(h.store.values.get(STAGE)).toMatch(/^refresh-/)

    const retry = await h.call('list_workspaces')
    expect(retry.isError).toBe(false)
    expect(retry.body.user).toBe('frank')
  })

  it('AC1: the listener answers 404 to a wrong state or path and keeps waiting', async () => {
    const h = await setup({ loggedIn: false })
    await h.call('list_workspaces')
    const redirect = new URL(h.opened[0] ?? '').searchParams.get('redirect_uri')
    expect((await fetch(`${redirect}/?state=wrong&code=x`)).status).toBe(404)
    expect((await fetch(`${redirect}/other?state=wrong&code=x`)).status).toBe(404)
    expect((await h.completeLogin()).status).toBe(200)
  })

  it('AC1: a login error is shown HTML-escaped and ends the login', async () => {
    const h = await setup({ loggedIn: false })
    await h.call('list_workspaces')
    const auth = new URL(h.opened[0] ?? '')
    const redirect = auth.searchParams.get('redirect_uri')
    const state = auth.searchParams.get('state') ?? ''
    const page = await fetch(`${redirect}/?state=${encodeURIComponent(state)}&error=%3Cscript%3E`)
    expect(await page.text()).toContain('&#60;script&#62;')

    await h.call('list_workspaces')
    expect(h.opened).toHaveLength(2)
  })

  it('AC1: without a browser the message contains the login URL', async () => {
    const world = new FakeWorld()
    const h = await setup({ loggedIn: false, world })
    ;(h.app.deps as { openBrowser: (url: string) => Promise<boolean> }).openBrowser = async () => false
    const result = await h.call('list_workspaces')
    expect(result.body.error).toContain(`https://${STAGE}/auth/realms/default/protocol/openid-connect/auth?`)
  })

  it('AC2: an expiring access token is refreshed once and the call completes', async () => {
    const h = await setup()
    await h.call('get_event', { workspace: WS_A, eventId: EVENT_A })
    expect(h.world.tokenRequests()).toHaveLength(1)

    h.world.now += h.world.tokenTtl - 29
    const result = await h.call('get_event', { workspace: WS_A, eventId: EVENT_A })

    expect(result.isError).toBe(false)
    expect(h.world.tokenRequests()).toHaveLength(2)
    expect(h.opened).toHaveLength(0)
  })

  it('AC2: a token with more than 30 s left is reused', async () => {
    const h = await setup()
    await h.call('get_event', { workspace: WS_A, eventId: EVENT_A })
    h.world.now += h.world.tokenTtl - 31
    await h.call('get_event', { workspace: WS_A, eventId: EVENT_A })
    expect(h.world.tokenRequests()).toHaveLength(1)
  })

  it('AC2: a backend 401 renews the token and retries once', async () => {
    const h = await setup()
    await h.call('get_event', { workspace: WS_A, eventId: EVENT_A })
    h.world.issued.length = 0
    const result = await h.call('get_event', { workspace: WS_A, eventId: EVENT_A })
    expect(result.isError).toBe(false)
    expect(h.world.tokenRequests()).toHaveLength(2)
  })

  it('AC3: a new process with a stored refresh token needs no login', async () => {
    const world = new FakeWorld()
    const store = new FakeStore()
    const first = await setup({ world, store })
    await first.call('list_workspaces')
    const kept = store.values.get(STAGE)
    await first.client.close()
    harnesses.splice(harnesses.indexOf(first), 1)

    const second = await createHarness(world, 'stage', store)
    harnesses.push(second)
    const result = await second.call('list_workspaces')

    expect(result.isError).toBe(false)
    expect(store.values.get(STAGE)).toBe(kept)
    expect(second.opened).toHaveLength(0)
  })

  it('AC4: logout deletes the keyring entry and the tokens; the next call starts the login', async () => {
    const h = await setup()
    await h.call('get_event', { workspace: WS_A, eventId: EVENT_A })
    const result = await h.call('logout')

    expect(result.body).toEqual({ realm: null, user: 'frank', workspace: null, message: 'Logged out from all realms.' })
    expect(h.store.values.has(STAGE)).toBe(false)

    const backendBefore = h.world.backendRequests().length
    const next = await h.call('get_event', { workspace: WS_A, eventId: EVENT_A })
    expect(next.body.error).toMatch(/^Login opened in your browser/)
    expect(h.opened).toHaveLength(1)
    expect(h.world.backendRequests()).toHaveLength(backendBefore)
  })

  it('session end: invalid_grant deletes the entry and starts the login without leaking error_description', async () => {
    const h = await setup()
    h.world.realms.get(STAGE)?.validRefreshTokens.clear()
    const result = await h.call('get_event', { workspace: WS_A, eventId: EVENT_A })

    expect(result.body.error).toMatch(/^Login opened in your browser for realm default/)
    expect(result.text).not.toContain('SECRETDESC')
    expect(h.store.values.has(STAGE)).toBe(false)
    expect(h.opened).toHaveLength(1)
  })

  it('session end: Keycloak 5xx keeps the session', async () => {
    const world = new FakeWorld()
    const h = await setup({ world })
    const original = world.fetch
    ;(h.app.deps as { fetch: typeof fetch }).fetch = async (input, init) =>
      String(input).endsWith('/token') ? new Response('', { status: 503 }) : original(input, init)
    const result = await h.call('get_event', { workspace: WS_A, eventId: EVENT_A })
    expect(result.body.error).toBe(`Keycloak at ${STAGE} is not reachable (HTTP 503).`)
    expect(h.store.values.has(STAGE)).toBe(true)
  })
})

describe('workspaces', () => {
  it('AC5: every tool answer carries realm, user and workspace', async () => {
    const h = await setup()
    const list = await h.call('list_workspaces')
    const event = await h.call('get_event', { workspace: 'Alpha', eventId: EVENT_A })
    const failed = await h.call('get_event', { workspace: WS_A, eventId: 'bad id' })
    const logout = await h.call('logout', { realm: 'default' })

    expect(list.body).toMatchObject({ realm: 'default', user: 'frank', workspace: null })
    expect(event.body).toMatchObject({ realm: 'default', user: 'frank', workspace: { id: WS_A, name: 'Alpha' } })
    expect(failed.body).toMatchObject({ realm: 'default', user: 'frank', workspace: null })
    expect(Object.keys(failed.body)).toEqual(['realm', 'user', 'workspace', 'error'])
    expect(logout.body).toMatchObject({ realm: 'default', user: 'frank', workspace: null })
  })

  it('AC5a: list_workspaces keeps only workspaces of the requested realm', async () => {
    const h = await setup()
    const result = await h.call('list_workspaces')
    expect(result.body.workspaces).toEqual([
      { id: WS_A, name: 'Alpha', realm: 'default' },
      { id: WS_B, name: 'Beta', realm: 'default' }
    ])
    const request = h.world.backendRequests()[0]
    expect(request?.url.pathname).toBe('/_gw/s-workspaces/api/workspaces')
    expect(request?.headers['accept-language']).toBe('en')
  })

  it('AC5b: the backend request uses the token whose claim equals W, sent as a form parameter', async () => {
    const h = await setup()
    await h.call('get_event', { workspace: WS_B, eventId: EVENT_B })

    const tokenRequest = h.world.tokenRequests()[0]
    expect(tokenRequest?.form?.get('workspace_id')).toBe(WS_B)
    expect(tokenRequest?.url.search).toBe('')
    const backend = h.world.backendRequests()[0]
    const claims = claimsOf((backend?.headers.authorization ?? '').replace('Bearer ', ''))
    expect(claims.COLADA_WORKSPACE_ID).toBe(WS_B)
  })

  it('AC5c: another claim gives "no access" and sends no backend request', async () => {
    const h = await setup()
    const result = await h.call('get_event', { workspace: WS_FOREIGN, eventId: EVENT_A })

    expect(result.isError).toBe(true)
    expect(result.body.error).toBe(
      `No access to workspace ${WS_FOREIGN} in realm default. You are not a member of it, it does not exist, or it belongs to another realm (see list_workspaces).`
    )
    expect(h.world.backendRequests()).toHaveLength(0)
    expect(h.logs.at(-1)?.httpStatus).toBeNull()
  })

  it('AC5c: a missing claim is a mismatch too', async () => {
    const world = new FakeWorld()
    world.addRealm(STAGE, { user: 'frank', homeWorkspace: undefined, members: [], workspaces: [] })
    const h = await setup({ world })
    const result = await h.call('get_event', { workspace: WS_A, eventId: EVENT_A })
    expect(result.body.error).toMatch(/^No access to workspace/)
    expect(h.world.backendRequests()).toHaveLength(0)
  })

  it('AC5d: a name with no match or several matches lists the candidates and sends no event request', async () => {
    const world = new FakeWorld()
    world.addRealm(STAGE, {
      user: 'frank',
      members: [WS_A, WS_B],
      workspaces: [workspace(WS_A, 'Same'), workspace(WS_B, 'Same')]
    })
    const h = await setup({ world })

    const none = await h.call('get_event', { workspace: 'Nope', eventId: EVENT_A })
    expect(none.body.error).toBe(
      `Workspace "Nope" matches no workspace. Your workspaces:\n${WS_A} — Same\n${WS_B} — Same`
    )

    const two = await h.call('get_event', { workspace: 'Same', eventId: EVENT_A })
    expect(two.body.error).toBe(`Workspace "Same" matches 2 workspaces:\n${WS_A} — Same\n${WS_B} — Same`)

    expect(h.world.backendRequests().filter((r) => r.url.pathname.includes('/s-events/'))).toHaveLength(0)
  })

  it('AC5e: one workspace and no parameter works; two workspaces and no parameter fails', async () => {
    const single = new FakeWorld()
    single.addRealm(STAGE, { user: 'frank', members: [WS_A], workspaces: [workspace(WS_A, 'Alpha')] })
    const one = await setup({ world: single })
    const ok = await one.call('get_event', { eventId: EVENT_A })
    expect(ok.isError).toBe(false)
    expect(ok.body.workspace).toEqual({ id: WS_A, name: 'Alpha' })

    const many = await setup()
    const fail = await many.call('get_event', { eventId: EVENT_A })
    expect(fail.body.error).toBe(`Pass "workspace": you have 2 workspaces:\n${WS_A} — Alpha\n${WS_B} — Beta`)
  })

  it('AC5f: parallel calls for A and B use separate tokens', async () => {
    const h = await setup()
    h.world.tokenDelayMs = 20
    h.world.backendDelayMs = 20
    const [a, b] = await Promise.all([
      h.call('get_event', { workspace: WS_A, eventId: EVENT_A }),
      h.call('get_event', { workspace: WS_B, eventId: EVENT_B })
    ])

    expect(a.body).toMatchObject({ workspace: { id: WS_A }, event: { uid: EVENT_A } })
    expect(b.body).toMatchObject({ workspace: { id: WS_B }, event: { uid: EVENT_B } })
    expect(h.world.tokenRequests().map((r) => r.form?.get('workspace_id'))).toEqual([WS_A, WS_B])
    const claims = h.world
      .backendRequests()
      .map((r) => claimsOf((r.headers.authorization ?? '').replace('Bearer ', '')).COLADA_WORKSPACE_ID)
    expect(claims.sort()).toEqual([WS_A, WS_B])
  })

  it('AC5f: parallel calls for the same workspace share one token request', async () => {
    const h = await setup()
    h.world.tokenDelayMs = 20
    await Promise.all([
      h.call('get_event', { workspace: WS_A, eventId: EVENT_A }),
      h.call('get_event', { workspace: WS_A, eventId: EVENT_A })
    ])
    expect(h.world.tokenRequests()).toHaveLength(1)
  })
})

describe('get_event and backend errors', () => {
  it('AC10: get_event returns the body unchanged', async () => {
    const h = await setup()
    const result = await h.call('get_event', { workspace: WS_A, eventId: EVENT_A })
    expect(result.body.event).toEqual({ uid: EVENT_A, title: 'Gala A', nested: { x: [1, 2] } })
    expect(h.world.backendRequests()[0]?.url.pathname).toBe(`/_gw/s-events/api/events/${EVENT_A}`)
  })

  it('AC11: 403 names the refused path', async () => {
    const h = await setup()
    h.world.backendStatus.set(`/_gw/s-events/api/events/${EVENT_A}`, 403)
    const result = await h.call('get_event', { workspace: WS_A, eventId: EVENT_A })
    expect(result.body.error).toBe(
      `GET /_gw/s-events/api/events/${EVENT_A} was refused (403): your role lacks access to this endpoint. Ask an admin for the permission.`
    )
    expect(h.logs.at(-1)?.httpStatus).toBe(403)
  })

  it('AC12: 404 names the event id', async () => {
    const h = await setup()
    const missing = 'eeeeeeee-0000-0000-0000-0000000000ff'
    const result = await h.call('get_event', { workspace: WS_A, eventId: missing })
    expect(result.body.error).toBe(`Event ${missing} not found in workspace ${WS_A}.`)
  })

  it('invalid event id sends no request', async () => {
    const h = await setup()
    const result = await h.call('get_event', { workspace: WS_A, eventId: '../workspaces' })
    expect(result.body.error).toBe('eventId "../workspaces" is not a valid Colada id.')
    expect(h.world.requests).toHaveLength(0)
  })

  it('AC13: every backend request is a GET with Accept-Language en', async () => {
    const h = await setup()
    await h.call('list_workspaces')
    await h.call('get_event', { workspace: WS_A, eventId: EVENT_A })
    for (const request of h.world.backendRequests()) {
      expect(request.method).toBe('GET')
      expect(request.headers['accept-language']).toBe('en')
      expect(request.headers.accept).toBe('application/json')
    }
  })

  it('AC14: one log line per call with the six fields and no body', async () => {
    const h = await setup()
    await h.call('get_event', { workspace: 'Alpha', eventId: EVENT_A })

    expect(h.logs).toHaveLength(1)
    const [entry] = h.logs
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      'httpStatus',
      'params',
      'realm',
      'time',
      'tool',
      'user',
      'workspace'
    ])
    expect(entry).toMatchObject({
      realm: 'default',
      user: 'frank',
      workspace: WS_A,
      tool: 'get_event',
      params: { workspace: 'Alpha', eventId: EVENT_A },
      httpStatus: 200
    })
    expect(JSON.stringify(h.logs)).not.toContain('Gala A')
  })
})

describe('realms', () => {
  async function prodWithLidl() {
    const world = new FakeWorld()
    world.addRealm(LIDL, {
      user: 'frank-lidl',
      homeWorkspace: WS_FOREIGN,
      members: [],
      rotation: true,
      workspaces: [workspace(WS_FOREIGN, 'Lidl WS', 'lidl'), workspace(WS_A, 'Alpha')]
    })
    const h = await setup({ env: 'prod', world })
    world.events.set(WS_FOREIGN, new Map([[EVENT_A, { uid: EVENT_A, title: 'Lidl event' }]]))
    return h
  }

  it('AC15/AC18: on stage a dedicated realm gives a clear error, opens no login and sends no request', async () => {
    const h = await setup()
    for (const tool of ['list_workspaces', 'get_event']) {
      const result = await h.call(tool, { realm: 'lidl', eventId: EVENT_A })
      expect(result.body.error).toBe('Realm lidl is not available on stage. Use default, or run with COLADA_ENV=prod.')
      expect(result.body.realm).toBe('lidl')
    }
    expect(h.opened).toHaveLength(0)
    expect(h.world.requests).toHaveLength(0)
  })

  it('AC16: realm lidl without a session logs in on the lidl host; afterwards calls go only there', async () => {
    const h = await prodWithLidl()
    const first = await h.call('list_workspaces', { realm: 'lidl' })

    expect(first.body.error).toBe(
      `Login opened in your browser for realm lidl on ${LIDL}. Finish it, then call the tool again.`
    )
    expect(new URL(h.opened[0] ?? '').host).toBe(LIDL)
    expect(new URL(h.opened[0] ?? '').pathname).toBe('/auth/realms/lidl/protocol/openid-connect/auth')
    expect(h.world.backendRequests()).toHaveLength(0)

    await h.completeLogin()
    const list = await h.call('list_workspaces', { realm: 'lidl' })
    expect(list.body).toMatchObject({ realm: 'lidl', user: 'frank-lidl' })
    expect(list.body.workspaces).toEqual([{ id: WS_FOREIGN, name: 'Lidl WS', realm: 'lidl' }])

    const event = await h.call('get_event', { realm: 'lidl', eventId: EVENT_A })
    expect(event.body).toMatchObject({ realm: 'lidl', workspace: { id: WS_FOREIGN }, event: { title: 'Lidl event' } })
    expect(h.world.requests.every((r) => r.url.host === LIDL)).toBe(true)
  })

  it('AC17: default and lidl sessions stay apart; logout lidl keeps default; logout without realm ends both', async () => {
    const h = await prodWithLidl()
    h.world.seedRefreshToken(LIDL, h.store)

    await h.call('get_event', { workspace: WS_A, eventId: EVENT_A })
    await h.call('get_event', { realm: 'lidl', eventId: EVENT_A })
    for (const request of h.world.requests) {
      const token = request.form?.get('refresh_token') ?? (request.headers.authorization ?? '').replace('Bearer ', '')
      expect(
        token.includes(request.url.host) || claimsOf(token).iss === `https://${request.url.host}/auth/realms/x`
      ).toBe(true)
    }

    const lidlOut = await h.call('logout', { realm: 'lidl' })
    expect(lidlOut.body).toMatchObject({ realm: 'lidl', user: 'frank-lidl', message: 'Logged out from lidl.' })
    expect(h.store.values.has(LIDL)).toBe(false)
    expect(h.store.values.has(PROD)).toBe(true)
    expect((await h.call('get_event', { workspace: WS_A, eventId: EVENT_A })).isError).toBe(false)

    const allOut = await h.call('logout')
    expect(allOut.body.message).toBe('Logged out from all realms.')
    expect(h.store.values.size).toBe(0)
  })

  it('D28: a rotated refresh token replaces the stored one; token requests of one realm run one at a time', async () => {
    const h = await prodWithLidl()
    h.world.seedRefreshToken(LIDL, h.store)
    const before = h.store.values.get(LIDL)
    h.world.tokenDelayMs = 20

    let active = 0
    let maxActive = 0
    const original = h.world.fetch
    ;(h.app.deps as { fetch: typeof fetch }).fetch = async (input, init) => {
      if (!String(input).endsWith('/token')) return original(input, init)
      active++
      maxActive = Math.max(maxActive, active)
      try {
        return await original(input, init)
      } finally {
        active--
      }
    }

    const results = await Promise.all([
      h.call('list_workspaces', { realm: 'lidl' }),
      h.call('get_event', { realm: 'lidl', workspace: WS_FOREIGN, eventId: EVENT_A })
    ])

    expect(results.map((r) => r.isError)).toEqual([false, false])
    expect(maxActive).toBe(1)
    const presented = h.world.tokenRequests(LIDL).map((r) => r.form?.get('refresh_token'))
    expect(presented[0]).toBe(before)
    expect(presented[1]).not.toBe(before)
    expect(h.store.values.get(LIDL)).not.toBe(before)
    expect(h.world.realms.get(LIDL)?.validRefreshTokens.has(h.store.values.get(LIDL) ?? '')).toBe(true)
  })
})

describe('NFR: no token in answers or logs', () => {
  it('no issued token appears in any tool answer, log line or stderr', async () => {
    const h = await setup({ loggedIn: false })
    const outputs: string[] = []
    outputs.push((await h.call('list_workspaces')).text)
    await h.completeLogin()
    outputs.push((await h.call('list_workspaces')).text)
    outputs.push((await h.call('get_event', { workspace: WS_A, eventId: EVENT_A })).text)
    outputs.push((await h.call('get_event', { workspace: WS_FOREIGN, eventId: EVENT_A })).text)
    h.world.realms.get(STAGE)?.validRefreshTokens.clear()
    outputs.push((await h.call('get_event', { workspace: WS_B, eventId: EVENT_B })).text)
    outputs.push((await h.call('logout')).text)

    const all = [...outputs, JSON.stringify(h.logs), ...h.stderr].join('\n')
    expect(h.world.issued.length).toBeGreaterThan(3)
    for (const token of h.world.issued) expect(all).not.toContain(token)
    expect(all).not.toMatch(/eyJ[a-zA-Z0-9_-]{10,}/)
    expect(all).not.toContain('SECRETVALUE')
  })
})

describe('tool definitions', () => {
  it('name no customer realm in tools/list, in stage and prod', async () => {
    for (const env of ['stage', 'prod'] as const) {
      const h = await setup({ env })
      const definitions = JSON.stringify(await h.client.listTools())
      expect(definitions).not.toMatch(/vw|abiomed|lidl/i)
    }
  })

  it('an unknown realm gives an error without the realm list and sends no request', async () => {
    const h = await setup({ env: 'prod' })
    const result = await h.call('get_event', { realm: 'acme', eventId: EVENT_A })
    expect(result.body).toMatchObject({
      realm: 'acme',
      user: null,
      workspace: null,
      error: 'Unknown realm "acme". Leave realm out for the main realm.'
    })
    expect(h.opened).toHaveLength(0)
    expect(h.world.requests).toHaveLength(0)
  })
})
