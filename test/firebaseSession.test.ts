import { afterEach, describe, expect, it } from 'vitest'
import type { CallState } from '../src/api/backend.js'
import {
  claimsOf,
  createHarness,
  FakeWorld,
  type Harness,
  json,
  jwt,
  STAGE_HOST,
  WS_A,
  WS_B,
  workspace
} from './harness.js'

const API_KEY = 'AIzaFAKEKEY000000000000000000000000000'
const CUSTOM_TOKEN = 'custom-token-SECRETCUSTOM'
const FIREBASE_REFRESH = 'firebase-refresh-SECRETREFRESH'
const IDENTITY_HOST = 'identitytoolkit.googleapis.com'
const CONFIG_PATH = '/_gw/s-access/api/auth/integrations/campaigns/firebase/config'
const TOKEN_PATH = '/_gw/s-access/api/auth/integrations/campaigns/firebase/token'
const PERMISSIONS_PATH = '/_gw/s-permissions/api/permissions/my'

const harnesses: Harness[] = []

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

interface FirebaseFake {
  config: Record<string, unknown>
  idTokenWorkspace: (requested: string) => string
  idTokenTtl: number
  permissions: unknown
  signInStatus: number
  idTokens: string[]
}

function workspaceOf(headers: Record<string, string>) {
  return String(claimsOf((headers.authorization ?? '').replace(/^Bearer /, '')).COLADA_WORKSPACE_ID)
}

async function setup() {
  const world = new FakeWorld()
  world.addRealm(STAGE_HOST, {
    user: 'frank',
    members: [WS_A, WS_B],
    workspaces: [workspace(WS_A, 'Alpha'), workspace(WS_B, 'Beta')]
  })
  const fake: FirebaseFake = {
    config: {
      apiKey: API_KEY,
      databaseURL: 'https://fake-campaigns-default-rtdb.europe-west1.firebasedatabase.app',
      projectId: 'fake-campaigns'
    },
    idTokenWorkspace: (requested) => requested,
    idTokenTtl: 3600,
    permissions: ['campaigns_app:view', 'campaigns_app/reports:view'],
    signInStatus: 200,
    idTokens: []
  }
  const lastWorkspace: string[] = []
  world.backendRaw.set(CONFIG_PATH, (_url, headers) => {
    lastWorkspace.push(workspaceOf(headers))
    return json(200, fake.config)
  })
  world.backendRaw.set(TOKEN_PATH, () => json(200, { value: CUSTOM_TOKEN }))
  world.backendRaw.set(PERMISSIONS_PATH, () => json(200, fake.permissions))
  world.externalRaw.set(IDENTITY_HOST, (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { token: string }
    if (fake.signInStatus !== 200 || body.token !== CUSTOM_TOKEN) {
      return json(fake.signInStatus === 200 ? 400 : fake.signInStatus, {
        error: { code: 400, message: 'INVALID_CUSTOM_TOKEN : Invalid assertion format.' }
      })
    }
    const requested = lastWorkspace.at(-1) ?? ''
    const idToken = jwt({
      sub: 'id-frank',
      user_id: 'id-frank',
      exp: world.now + fake.idTokenTtl,
      COLADA_WORKSPACE_ID: fake.idTokenWorkspace(requested),
      roles: ['campaigns_app_planner', 'default-roles']
    })
    fake.idTokens.push(idToken)
    return json(200, { idToken, refreshToken: FIREBASE_REFRESH, expiresIn: String(fake.idTokenTtl) })
  })
  const h = await createHarness(world)
  harnesses.push(h)
  world.seedRefreshToken(STAGE_HOST, h.store)
  const { firebase } = await h.app.realm(undefined)
  const state: CallState = { httpStatus: null }
  return { h, world, fake, firebase, state }
}

function firebaseRequests(world: FakeWorld) {
  return world.requests.filter(
    (r) => r.url.host === IDENTITY_HOST || [CONFIG_PATH, TOKEN_PATH, PERMISSIONS_PATH].includes(r.url.pathname)
  )
}

describe('Firebase session (SPEC-phase4 F16, CONTRACT-phase4 §6.1)', () => {
  it('AC-F1: mints config → custom token → sign-in → permissions with the workspace token', async () => {
    const { world, firebase, state } = await setup()
    const access = await firebase.access(WS_A, 'campaigns', state)

    expect(access.config).toEqual({
      apiKey: API_KEY,
      databaseHost: 'fake-campaigns-default-rtdb.europe-west1.firebasedatabase.app',
      projectId: 'fake-campaigns'
    })
    expect(access.uid).toBe('id-frank')
    expect(access.roles).toEqual(['campaigns_app_planner', 'default-roles'])
    expect([...access.permissions]).toEqual(['campaigns_app:view', 'campaigns_app/reports:view'])

    const calls = firebaseRequests(world)
    expect(calls.map((r) => `${r.method} ${r.url.host === IDENTITY_HOST ? IDENTITY_HOST : r.url.pathname}`)).toEqual([
      `GET ${CONFIG_PATH}`,
      `POST ${TOKEN_PATH}`,
      `POST ${IDENTITY_HOST}`,
      `GET ${PERMISSIONS_PATH}`
    ])
    for (const r of calls.filter((r) => r.url.host === STAGE_HOST)) {
      expect(claimsOf((r.headers.authorization ?? '').replace(/^Bearer /, '')).COLADA_WORKSPACE_ID).toBe(WS_A)
    }
  })

  it('signs in without Referer, Origin or Authorization, with the API key only in the query', async () => {
    const { world, firebase, state } = await setup()
    await firebase.access(WS_A, 'campaigns', state)
    const signIn = world.requests.find((r) => r.url.host === IDENTITY_HOST)

    expect(signIn?.url.pathname).toBe('/v1/accounts:signInWithCustomToken')
    expect(signIn?.url.searchParams.get('key')).toBe(API_KEY)
    expect(signIn?.redirect).toBe('error')
    expect(Object.keys(signIn?.headers ?? {}).sort()).toEqual(['accept', 'content-type'])
    expect(JSON.parse(signIn?.body ?? '{}')).toEqual({ token: CUSTOM_TOKEN, returnSecureToken: true })
  })

  it('AC-F2: refuses an ID token of another workspace and caches nothing', async () => {
    const { fake, firebase, state, world } = await setup()
    fake.idTokenWorkspace = () => WS_B

    await expect(firebase.access(WS_A, 'campaigns', state)).rejects.toThrow(
      'The Firebase token is for another workspace. Nothing was read.'
    )
    expect(world.requests.some((r) => r.url.pathname === PERMISSIONS_PATH)).toBe(false)

    fake.idTokenWorkspace = (requested) => requested
    await firebase.access(WS_A, 'campaigns', state)
    expect(world.requests.filter((r) => r.url.pathname === CONFIG_PATH)).toHaveLength(2)
  })

  it('keeps one access per workspace and reuses it while it is valid', async () => {
    const { world, firebase, state } = await setup()
    const [first, second] = await Promise.all([
      firebase.access(WS_A, 'campaigns', state),
      firebase.access(WS_A, 'campaigns', state)
    ])
    const third = await firebase.access(WS_A, 'campaigns', state)
    const other = await firebase.access(WS_B, 'campaigns', state)

    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(claimsOf(other.idToken).COLADA_WORKSPACE_ID).toBe(WS_B)
    expect(world.requests.filter((r) => r.url.host === IDENTITY_HOST)).toHaveLength(2)
  })

  it('AC-F5: mints again when the ID token expires in less than 60 s', async () => {
    const { world, fake, firebase, state } = await setup()
    fake.idTokenTtl = 3600
    const first = await firebase.access(WS_A, 'campaigns', state)
    world.now += 3541
    const second = await firebase.access(WS_A, 'campaigns', state)

    expect(second.idToken).not.toBe(first.idToken)
    expect(world.requests.filter((r) => r.url.host === IDENTITY_HOST)).toHaveLength(2)
  })

  it('drop() forces a new mint on the next call', async () => {
    const { world, firebase, state } = await setup()
    await firebase.access(WS_A, 'campaigns', state)
    firebase.drop(WS_A, 'campaigns')
    await firebase.access(WS_A, 'campaigns', state)
    expect(world.requests.filter((r) => r.url.host === IDENTITY_HOST)).toHaveLength(2)
  })

  it('AC-F6: logout drops every Firebase access of the realm', async () => {
    const { h, world, firebase, state } = await setup()
    await firebase.access(WS_A, 'campaigns', state)
    await h.call('logout')

    await expect(firebase.access(WS_A, 'campaigns', state)).rejects.toThrow(/Login opened in your browser/)
    expect(world.requests.filter((r) => r.url.host === IDENTITY_HOST)).toHaveLength(1)
  })

  it('a session end during a mint does not cache the result', async () => {
    const { world, firebase, state } = await setup()
    world.backendDelayMs = 20
    const running = firebase.access(WS_A, 'campaigns', state)
    await new Promise((r) => setTimeout(r, 5))
    firebase.clear()

    await expect(running).rejects.toThrow('The session ended while this call was running.')
    world.backendDelayMs = 0
    await firebase.access(WS_A, 'campaigns', state)
    expect(world.requests.filter((r) => r.url.host === IDENTITY_HOST)).toHaveLength(2)
  })

  it.each([
    [403, 'You have no Campaigns access in workspace aaaaaaaa-0000-0000-0000-000000000001 (campaigns_app:view).'],
    [500, 'Campaigns is not set up for workspace aaaaaaaa-0000-0000-0000-000000000001.']
  ])('config answer %i is reported in Campaigns words', async (status, text) => {
    const { world, firebase, state } = await setup()
    world.backendStatus.set(CONFIG_PATH, status)
    await expect(firebase.access(WS_A, 'campaigns', state)).rejects.toThrow(text)
  })

  it('a 500 of the token route is reported as "not set up"', async () => {
    const { world, firebase, state } = await setup()
    world.backendStatus.set(TOKEN_PATH, 500)
    await expect(firebase.access(WS_A, 'campaigns', state)).rejects.toThrow(
      'Campaigns is not set up for workspace aaaaaaaa-0000-0000-0000-000000000001.'
    )
  })

  it.each([
    ['databaseURL', 'https://evil.example.com', 'invalid databaseURL ("https://evil.example.com")'],
    ['databaseURL', 'https://x.firebaseio.com/path', 'invalid databaseURL ("https://x.firebaseio.com/path")'],
    ['databaseURL', 'http://x.firebaseio.com', 'invalid databaseURL ("http://x.firebaseio.com")'],
    ['databaseURL', null, 'invalid databaseURL ("null")'],
    ['projectId', 'Bad_Project', 'invalid projectId ("Bad_Project")'],
    ['apiKey', 'short', 'invalid apiKey ("hidden")'],
    ['apiKey', undefined, 'invalid apiKey ("undefined")']
  ])('AC-F7: rejects config %s = %s before any Firebase request', async (field, value, text) => {
    const { world, fake, firebase, state } = await setup()
    fake.config = { ...fake.config, [field]: value }

    await expect(firebase.access(WS_A, 'campaigns', state)).rejects.toThrow(text)
    expect(world.requests.some((r) => r.url.pathname === TOKEN_PATH || r.url.host === IDENTITY_HOST)).toBe(false)
  })

  it('accepts the classic firebaseio.com database URL', async () => {
    const { fake, firebase, state } = await setup()
    fake.config = { ...fake.config, databaseURL: 'https://fake-campaigns.firebaseio.com' }
    const access = await firebase.access(WS_A, 'campaigns', state)
    expect(access.config.databaseHost).toBe('fake-campaigns.firebaseio.com')
  })

  it('shows the Identity Toolkit error code, never the key or the custom token', async () => {
    const { fake, firebase, state } = await setup()
    fake.signInStatus = 400
    const error = await firebase.access(WS_A, 'campaigns', state).catch((err: Error) => err)

    expect(String(error)).toContain('Firebase sign-in failed (400, INVALID_CUSTOM_TOKEN). Nothing was read.')
    expect(String(error)).not.toContain(API_KEY)
    expect(String(error)).not.toContain(CUSTOM_TOKEN)
  })

  it.each([[{ list: [] }], [[1, 2]], [null]])('refuses an unreadable permission list %j', async (body) => {
    const { fake, firebase, state } = await setup()
    fake.permissions = body
    await expect(firebase.access(WS_A, 'campaigns', state)).rejects.toThrow(
      'Cannot read your Campaigns permissions in workspace aaaaaaaa-0000-0000-0000-000000000001. Nothing was read.'
    )
  })

  it('AC-F3, AC-F4: no Firebase token or key reaches the keyring, the call log or stderr', async () => {
    const { h, fake, firebase, state } = await setup()
    await firebase.access(WS_A, 'campaigns', state)
    const secrets = [API_KEY, CUSTOM_TOKEN, FIREBASE_REFRESH, ...fake.idTokens]
    const stored = [...h.store.values.values()].join('\n')
    const logged = JSON.stringify(h.logs) + h.stderr.join('\n')

    for (const secret of secrets) {
      expect(stored).not.toContain(secret)
      expect(logged).not.toContain(secret)
    }
  })

  it('the custom-token POST does not use the write budget', async () => {
    const { firebase, state, world } = await setup()
    for (let i = 0; i < 61; i++) {
      firebase.drop(WS_A, 'campaigns')
      await firebase.access(WS_A, 'campaigns', state)
    }
    expect(world.requests.filter((r) => r.url.pathname === TOKEN_PATH)).toHaveLength(61)
  })
})
