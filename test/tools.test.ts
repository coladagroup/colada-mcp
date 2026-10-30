import { afterEach, describe, expect, it } from 'vitest'
import {
  claimsOf,
  createHarness,
  EVENT_A,
  EVENT_B,
  eventPath,
  FakeStore,
  FakeWorld,
  type Harness,
  json,
  WS_A,
  WS_B,
  WS_FOREIGN,
  workspace
} from './harness.js'

const STAGE = 'stage-admin.colada365.com'
const PROD = 'admin.colada365.com'
const CLIENT = 'client.example.com'

const harnesses: Harness[] = []

async function setup(options: { hosts?: string[]; loggedIn?: boolean; world?: FakeWorld; store?: FakeStore } = {}) {
  const hosts = options.hosts ?? [STAGE]
  const host = hosts[0] ?? STAGE
  const world = options.world ?? new FakeWorld()
  if (!world.realms.has(host)) {
    world.addRealm(host, {
      user: 'frank',
      members: [WS_A, WS_B],
      workspaces: [workspace(WS_A, 'Alpha'), workspace(WS_B, 'Beta'), workspace(WS_FOREIGN, 'Client WS', 'client')]
    })
  }
  world.events.set(WS_A, new Map([[EVENT_A, { uid: EVENT_A, title: 'Gala A', nested: { x: [1, 2] } }]]))
  world.events.set(WS_B, new Map([[EVENT_B, { uid: EVENT_B, title: 'Gala B' }]]))
  const store = options.store ?? new FakeStore()
  if (options.loggedIn !== false && !store.values.has(host)) world.seedRefreshToken(host, store)
  const harness = await createHarness(world, hosts, store)
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
      `Login opened in your browser for realm default on ${STAGE}. Finish it, then call the tool again. If no browser tab opened, open this URL: ${h.opened[0]}`
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
    const second = await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })

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

  it('AC1: when the browser launcher fails the login still starts and the message has the URL', async () => {
    const h = await setup({ loggedIn: false })
    ;(h.app.deps as { openBrowser: (url: string) => Promise<void> }).openBrowser = async () => {
      throw new Error('no browser')
    }
    const result = await h.call('list_workspaces')
    expect(result.body.error).toContain(`https://${STAGE}/auth/realms/default/protocol/openid-connect/auth?`)
    expect(h.stderr).toEqual(['colada-mcp: cannot open the browser (no browser)'])
    await h.completeLogin(String(result.body.error).split('open this URL: ')[1])
    expect((await h.call('list_workspaces')).isError).toBe(false)
  })

  it('AC2: an expiring access token is refreshed once and the call completes', async () => {
    const h = await setup()
    await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
    expect(h.world.tokenRequests()).toHaveLength(1)

    h.world.now += h.world.tokenTtl - 29
    const result = await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })

    expect(result.isError).toBe(false)
    expect(h.world.tokenRequests()).toHaveLength(2)
    expect(h.opened).toHaveLength(0)
  })

  it('AC2: a token with more than 30 s left is reused', async () => {
    const h = await setup()
    await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
    h.world.now += h.world.tokenTtl - 31
    await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
    expect(h.world.tokenRequests()).toHaveLength(1)
  })

  it('AC2: a backend 401 renews the token and retries once', async () => {
    const h = await setup()
    await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
    h.world.issued.length = 0
    const result = await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
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

    const second = await createHarness(world, [STAGE], store)
    harnesses.push(second)
    const result = await second.call('list_workspaces')

    expect(result.isError).toBe(false)
    expect(store.values.get(STAGE)).toBe(kept)
    expect(second.opened).toHaveLength(0)
  })

  it('AC4: logout deletes the keyring entry and the tokens; the next call starts the login', async () => {
    const h = await setup()
    await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
    const result = await h.call('logout')

    expect(result.body).toEqual({
      realm: 'default',
      user: 'frank',
      workspace: null,
      message: 'Logged out from default.'
    })
    expect(h.store.values.has(STAGE)).toBe(false)

    const backendBefore = h.world.backendRequests().length
    const next = await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
    expect(next.body.error).toMatch(/^Login opened in your browser/)
    expect(h.opened).toHaveLength(1)
    expect(h.world.backendRequests()).toHaveLength(backendBefore)
  })

  it('session end: invalid_grant deletes the entry and starts the login without leaking error_description', async () => {
    const h = await setup()
    h.world.realms.get(STAGE)?.validRefreshTokens.clear()
    const result = await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })

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
    const result = await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
    expect(result.body.error).toBe(`Keycloak at ${STAGE} is not reachable (HTTP 503).`)
    expect(h.store.values.has(STAGE)).toBe(true)
  })

  it('session end: a Keycloak 4xx other than invalid_grant says the request was refused and keeps the session', async () => {
    const world = new FakeWorld()
    const h = await setup({ world })
    const original = world.fetch
    ;(h.app.deps as { fetch: typeof fetch }).fetch = async (input, init) =>
      String(input).endsWith('/token') ? json(400, { error: 'invalid_client' }) : original(input, init)
    const result = await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
    expect(result.body.error).toBe(`Keycloak at ${STAGE} refused the token request (HTTP 400).`)
    expect(h.store.values.has(STAGE)).toBe(true)
    expect(h.opened).toHaveLength(0)
  })
})

describe('workspaces', () => {
  it('AC5: every tool answer carries realm, user and workspace', async () => {
    const h = await setup()
    const list = await h.call('list_workspaces')
    const event = await h.call('api_get', { workspace: 'Alpha', ...eventPath(EVENT_A) })
    const failed = await h.call('api_get', { workspace: WS_A, ...eventPath('eeeeeeee-0000-0000-0000-0000000000ff') })
    const logout = await h.call('logout', { realm: 'default' })

    expect(list.body).toMatchObject({ realm: 'default', user: 'frank', workspace: null })
    expect(event.body).toMatchObject({ realm: 'default', user: 'frank', workspace: { id: WS_A, name: 'Alpha' } })
    expect(failed.body).toMatchObject({ realm: 'default', user: 'frank', workspace: { id: WS_A, name: 'Alpha' } })
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
    await h.call('api_get', { workspace: WS_B, ...eventPath(EVENT_B) })

    const tokenRequest = h.world.tokenRequests()[0]
    expect(tokenRequest?.form?.get('workspace_id')).toBe(WS_B)
    expect(tokenRequest?.url.search).toBe('')
    const backend = h.world.backendRequests()[0]
    const claims = claimsOf((backend?.headers.authorization ?? '').replace('Bearer ', ''))
    expect(claims.COLADA_WORKSPACE_ID).toBe(WS_B)
  })

  it('AC5c: another claim gives "no access" and sends no backend request', async () => {
    const h = await setup()
    const result = await h.call('api_get', { workspace: WS_FOREIGN, ...eventPath(EVENT_A) })

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
    const result = await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
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

    const none = await h.call('api_get', { workspace: 'Nope', ...eventPath(EVENT_A) })
    expect(none.body.error).toBe(
      `Workspace "Nope" matches no workspace. Your workspaces:\n${WS_A} — Same\n${WS_B} — Same`
    )

    const two = await h.call('api_get', { workspace: 'Same', ...eventPath(EVENT_A) })
    expect(two.body.error).toBe(`Workspace "Same" matches 2 workspaces:\n${WS_A} — Same\n${WS_B} — Same`)

    expect(h.world.backendRequests().filter((r) => r.url.pathname.includes('/s-events/'))).toHaveLength(0)
  })

  it('AC5e: one workspace and no parameter works; two workspaces and no parameter fails', async () => {
    const single = new FakeWorld()
    single.addRealm(STAGE, { user: 'frank', members: [WS_A], workspaces: [workspace(WS_A, 'Alpha')] })
    const one = await setup({ world: single })
    const ok = await one.call('api_get', { ...eventPath(EVENT_A) })
    expect(ok.isError).toBe(false)
    expect(ok.body.workspace).toEqual({ id: WS_A, name: 'Alpha' })

    const many = await setup()
    const fail = await many.call('api_get', { ...eventPath(EVENT_A) })
    expect(fail.body.error).toBe(`Pass "workspace": you have 2 workspaces:\n${WS_A} — Alpha\n${WS_B} — Beta`)
  })

  it('AC5f: parallel calls for A and B use separate tokens', async () => {
    const h = await setup()
    h.world.tokenDelayMs = 20
    h.world.backendDelayMs = 20
    const [a, b] = await Promise.all([
      h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) }),
      h.call('api_get', { workspace: WS_B, ...eventPath(EVENT_B) })
    ])

    expect(a.body).toMatchObject({ workspace: { id: WS_A }, body: { uid: EVENT_A } })
    expect(b.body).toMatchObject({ workspace: { id: WS_B }, body: { uid: EVENT_B } })
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
      h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) }),
      h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
    ])
    expect(h.world.tokenRequests()).toHaveLength(1)
  })
})

describe('api_get and backend errors', () => {
  it('AC19: api_get returns the status and the body unchanged', async () => {
    const h = await setup()
    const result = await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
    expect(result.body.status).toBe(200)
    expect(result.body.body).toEqual({ uid: EVENT_A, title: 'Gala A', nested: { x: [1, 2] } })
    expect(h.world.backendRequests()[0]?.url.pathname).toBe(`/_gw/s-events/api/events/${EVENT_A}`)
  })

  it('AC11: 403 names the refused path', async () => {
    const h = await setup()
    h.world.backendStatus.set(`/_gw/s-events/api/events/${EVENT_A}`, 403)
    const result = await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
    expect(result.body.error).toBe(
      `GET /_gw/s-events/api/events/${EVENT_A} was refused (403): your role lacks access to this endpoint. Ask an admin for the permission.`
    )
    expect(h.logs.at(-1)?.httpStatus).toBe(403)
  })

  it('404 names the path and the workspace', async () => {
    const h = await setup()
    const missing = 'eeeeeeee-0000-0000-0000-0000000000ff'
    const result = await h.call('api_get', { workspace: WS_A, ...eventPath(missing) })
    expect(result.body.error).toBe(
      `GET /_gw/s-events/api/events/${missing} returned 404 in workspace ${WS_A}: the object or the route does not exist. Check the path with get_api_doc.`
    )
  })

  it('a refused path sends no request and opens no realm', async () => {
    const h = await setup()
    const result = await h.call('api_get', { workspace: WS_A, ...eventPath('../workspaces') })
    expect(result.body.error).toBe(
      'Path "/api/events/../workspaces" is not allowed: it must not contain ".." or "//". Put query parameters in "query".'
    )
    expect(h.world.configRequests).toHaveLength(0)
    expect(h.world.requests).toHaveLength(0)
  })

  it('AC13: every backend request is a GET with Accept-Language en', async () => {
    const h = await setup()
    await h.call('list_workspaces')
    await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
    for (const request of h.world.backendRequests()) {
      expect(request.method).toBe('GET')
      expect(request.headers['accept-language']).toBe('en')
      expect(request.headers.accept).toBe('application/json')
    }
  })

  it('AC31: one log line per generic call with the CONTRACT §7 keys and no body', async () => {
    const h = await setup()
    await h.call('api_get', { workspace: 'Alpha', ...eventPath(EVENT_A) })

    expect(h.logs).toHaveLength(1)
    const [entry] = h.logs
    expect(Object.keys(entry ?? {})).toEqual([
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
    expect(entry).toMatchObject({
      realm: 'default',
      user: 'frank',
      workspace: WS_A,
      tool: 'api_get',
      method: 'GET',
      service: 's-events',
      path: `/api/events/${EVENT_A}`,
      query: {},
      ifMatch: false,
      httpStatus: 200
    })
    expect(JSON.stringify(h.logs)).not.toContain('Gala A')
  })
})

describe('realms', () => {
  async function prodWithClient() {
    const world = new FakeWorld()
    world.addRealm(CLIENT, {
      name: 'client',
      user: 'frank-client',
      homeWorkspace: WS_FOREIGN,
      members: [],
      rotation: true,
      workspaces: [workspace(WS_FOREIGN, 'Client WS', 'client'), workspace(WS_A, 'Alpha')]
    })
    const h = await setup({ hosts: [PROD, CLIENT], world })
    world.events.set(WS_FOREIGN, new Map([[EVENT_A, { uid: EVENT_A, title: 'Client event' }]]))
    return h
  }

  it('AC18: the realm of each host comes from its public config, once per process', async () => {
    const h = await prodWithClient()
    h.world.seedRefreshToken(CLIENT, h.store)
    await h.call('list_workspaces')
    await h.call('list_workspaces', { realm: 'client' })
    await h.call('api_get', { realm: 'client', ...eventPath(EVENT_A) })
    expect(h.world.configRequests.sort()).toEqual([PROD, CLIENT].sort())
    const definitions = (await h.client.listTools()).tools.filter((tool) => tool.name !== 'get_conventions')
    for (const tool of definitions) expect(Object.keys(tool.inputSchema.properties ?? {}), tool.name).toContain('realm')
  })

  it('AC18: an unreadable realm config gives a clear error, opens no login, and is read again on the next call', async () => {
    const h = await setup({ loggedIn: false })
    h.world.configStatus.set(STAGE, 404)
    const result = await h.call('list_workspaces')
    expect(result.body).toEqual({
      realm: null,
      user: null,
      workspace: null,
      error: `Cannot read the Keycloak realm of ${STAGE} (HTTP 404). Check COLADA_HOSTS.`
    })
    expect(h.opened).toHaveLength(0)
    expect(h.world.requests).toHaveLength(0)

    h.world.configStatus.delete(STAGE)
    const next = await h.call('list_workspaces')
    expect(next.body.error).toMatch(/^Login opened in your browser for realm default /)
    expect(h.world.configRequests).toEqual([STAGE, STAGE])
  })

  it('AC18: two hosts with the same realm give a clear error and send no request', async () => {
    const world = new FakeWorld()
    world.addRealm(CLIENT, { user: 'frank-client' })
    const h = await setup({ hosts: [PROD, CLIENT], world })
    const result = await h.call('list_workspaces')
    expect(result.body.error).toBe('Two hosts in COLADA_HOSTS use realm default. Keep only one of them.')
    expect(h.opened).toHaveLength(0)
    expect(h.world.requests).toHaveLength(0)
  })

  it('AC16: realm client without a session logs in on the client host; afterwards calls go only there', async () => {
    const h = await prodWithClient()
    const first = await h.call('list_workspaces', { realm: 'client' })

    expect(first.body.error).toBe(
      `Login opened in your browser for realm client on ${CLIENT}. Finish it, then call the tool again. If no browser tab opened, open this URL: ${h.opened[0]}`
    )
    expect(new URL(h.opened[0] ?? '').host).toBe(CLIENT)
    expect(new URL(h.opened[0] ?? '').pathname).toBe('/auth/realms/client/protocol/openid-connect/auth')
    expect(h.world.backendRequests()).toHaveLength(0)

    await h.completeLogin()
    const list = await h.call('list_workspaces', { realm: 'client' })
    expect(list.body).toMatchObject({ realm: 'client', user: 'frank-client' })
    expect(list.body.workspaces).toEqual([{ id: WS_FOREIGN, name: 'Client WS', realm: 'client' }])

    const event = await h.call('api_get', { realm: 'client', ...eventPath(EVENT_A) })
    expect(event.body).toMatchObject({
      realm: 'client',
      workspace: { id: WS_FOREIGN },
      body: { title: 'Client event' }
    })
    expect(h.world.requests.every((r) => r.url.host === CLIENT)).toBe(true)
  })

  it('AC17: default and client sessions stay apart; logout client keeps default; logout without realm ends both', async () => {
    const h = await prodWithClient()
    h.world.seedRefreshToken(CLIENT, h.store)

    await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
    await h.call('api_get', { realm: 'client', ...eventPath(EVENT_A) })
    for (const request of h.world.requests) {
      const token = request.form?.get('refresh_token') ?? (request.headers.authorization ?? '').replace('Bearer ', '')
      expect(
        token.includes(request.url.host) || claimsOf(token).iss === `https://${request.url.host}/auth/realms/x`
      ).toBe(true)
    }

    const clientOut = await h.call('logout', { realm: 'client' })
    expect(clientOut.body).toMatchObject({ realm: 'client', user: 'frank-client', message: 'Logged out from client.' })
    expect(h.store.values.has(CLIENT)).toBe(false)
    expect(h.store.values.has(PROD)).toBe(true)
    expect((await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })).isError).toBe(false)
    const clientBackendCalls = h.world.backendRequests(CLIENT).length
    const clientAgain = await h.call('api_get', { realm: 'client', ...eventPath(EVENT_A) })
    expect(clientAgain.body.error).toMatch(/^Login opened in your browser for realm client /)
    expect(h.world.backendRequests(CLIENT)).toHaveLength(clientBackendCalls)

    const allOut = await h.call('logout')
    expect(allOut.body.message).toBe('Logged out from all realms.')
    expect(h.store.values.size).toBe(0)
    const backendCalls = h.world.backendRequests().length
    for (const args of [{ workspace: WS_A }, { realm: 'client' }]) {
      const again = await h.call('api_get', { ...args, ...eventPath(EVENT_A) })
      expect(again.body.error).toMatch(/^Login opened in your browser /)
    }
    expect(h.world.backendRequests()).toHaveLength(backendCalls)
  })

  it('AC17: logout without realm ends every other realm when the keyring fails for one', async () => {
    const h = await prodWithClient()
    h.world.seedRefreshToken(CLIENT, h.store)
    await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })
    await h.call('api_get', { realm: 'client', ...eventPath(EVENT_A) })
    const remove = h.store.delete.bind(h.store)
    h.store.delete = async (account) => {
      if (account === PROD) throw new Error('store locked')
      await remove(account)
    }

    const result = await h.call('logout')
    h.store.delete = remove
    expect(result.isError).toBe(true)
    expect(result.body.error).toBe(
      'Could not remove the stored session of realm default from the OS keyring. Call logout again.'
    )
    expect(h.store.values.has(CLIENT)).toBe(false)
    const clientBackendCalls = h.world.backendRequests(CLIENT).length
    const client = await h.call('api_get', { realm: 'client', ...eventPath(EVENT_A) })
    expect(client.body.error).toMatch(/^Login opened in your browser for realm client /)
    expect(h.world.backendRequests(CLIENT)).toHaveLength(clientBackendCalls)
  })

  it('D28: a rotated refresh token replaces the stored one; token requests of one realm run one at a time', async () => {
    const h = await prodWithClient()
    h.world.seedRefreshToken(CLIENT, h.store)
    const before = h.store.values.get(CLIENT)
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
      h.call('list_workspaces', { realm: 'client' }),
      h.call('api_get', { realm: 'client', workspace: WS_FOREIGN, ...eventPath(EVENT_A) })
    ])

    expect(results.map((r) => r.isError)).toEqual([false, false])
    expect(maxActive).toBe(1)
    const presented = h.world.tokenRequests(CLIENT).map((r) => r.form?.get('refresh_token'))
    expect(presented[0]).toBe(before)
    expect(presented[1]).not.toBe(before)
    expect(h.store.values.get(CLIENT)).not.toBe(before)
    expect(h.world.realms.get(CLIENT)?.validRefreshTokens.has(h.store.values.get(CLIENT) ?? '')).toBe(true)
  })
})

describe('NFR: no token in answers or logs', () => {
  it('no issued token appears in any tool answer, log line or stderr', async () => {
    const h = await setup({ loggedIn: false })
    const outputs: string[] = []
    outputs.push((await h.call('list_workspaces')).text)
    await h.completeLogin()
    outputs.push((await h.call('list_workspaces')).text)
    outputs.push((await h.call('api_get', { workspace: WS_A, ...eventPath(EVENT_A) })).text)
    outputs.push((await h.call('api_get', { workspace: WS_FOREIGN, ...eventPath(EVENT_A) })).text)
    h.world.realms.get(STAGE)?.validRefreshTokens.clear()
    outputs.push((await h.call('api_get', { workspace: WS_B, ...eventPath(EVENT_B) })).text)
    outputs.push((await h.call('logout')).text)

    const all = [...outputs, JSON.stringify(h.logs), ...h.stderr].join('\n')
    expect(h.world.issued.length).toBeGreaterThan(3)
    for (const token of h.world.issued) expect(all).not.toContain(token)
    expect(all).not.toMatch(/eyJ[a-zA-Z0-9_-]{10,}/)
    expect(all).not.toContain('SECRETVALUE')
  })
})

describe('tool definitions', () => {
  it('name no customer host or realm in tools/list', async () => {
    const tenant = 'tenant.example.com'
    const world = new FakeWorld()
    world.addRealm(tenant, { name: 'tenant', user: 'frank-tenant' })
    for (const hosts of [[STAGE], [PROD, tenant]]) {
      const h = await setup({ hosts, world })
      const definitions = JSON.stringify(await h.client.listTools())
      expect(definitions).not.toMatch(/tenant|colada365/i)
    }
  })

  it('an unknown realm gives an error without the realm list and sends no request', async () => {
    const world = new FakeWorld()
    world.addRealm(CLIENT, { name: 'client', user: 'frank-client' })
    const h = await setup({ hosts: [PROD, CLIENT], world })
    const result = await h.call('api_get', { realm: 'acme', ...eventPath(EVENT_A) })
    expect(result.body).toMatchObject({
      realm: 'acme',
      user: null,
      workspace: null,
      error: 'Unknown realm "acme". Leave realm out unless the user names another realm.'
    })
    expect(h.opened).toHaveLength(0)
    expect(h.world.requests).toHaveLength(0)
  })
})
