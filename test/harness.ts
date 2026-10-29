import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { App } from '../src/app.js'
import type { TokenStore } from '../src/auth/tokenStore.js'
import type { CallLogEntry } from '../src/callLog.js'
import { createServer } from '../src/server.js'

export const WS_A = 'aaaaaaaa-0000-0000-0000-000000000001'
export const WS_B = 'bbbbbbbb-0000-0000-0000-000000000002'
export const WS_FOREIGN = 'ffffffff-0000-0000-0000-000000000009'
export const EVENT_A = 'eeeeeeee-0000-0000-0000-00000000000a'
export const EVENT_B = 'eeeeeeee-0000-0000-0000-00000000000b'

export function jwt(claims: Record<string, unknown>): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'RS256' })}.${part(claims)}.c2lnbmF0dXJl`
}

export function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
}

export class FakeStore implements TokenStore {
  readonly values = new Map<string, string>()
  async get(account: string) {
    return this.values.get(account) ?? null
  }
  async set(account: string, value: string) {
    this.values.set(account, value)
  }
  async delete(account: string) {
    this.values.delete(account)
  }
}

export interface FakeRealm {
  name: string
  user: string
  homeWorkspace: string | undefined
  members: string[]
  workspaces: Array<Record<string, unknown>>
  rotation: boolean
  validRefreshTokens: Set<string>
}

export interface Recorded {
  url: URL
  method: string
  headers: Record<string, string>
  form: URLSearchParams | null
  body: string | null
  redirect: RequestRedirect | undefined
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

export const DOCS_PATH = '/_gw/s-ecosystem/api/api-docs'

export class FakeWorld {
  now = 1_800_000_000
  tokenTtl = 300
  readonly requests: Recorded[] = []
  readonly configRequests: string[] = []
  readonly configStatus = new Map<string, number>()
  readonly issued: string[] = []
  readonly realms = new Map<string, FakeRealm>()
  readonly events = new Map<string, Map<string, unknown>>()
  readonly backendStatus = new Map<string, number>()
  readonly backendRaw = new Map<string, (url: URL, headers: Record<string, string>) => Response>()
  backendDelayMs = 0
  tokenDelayMs = 0
  private counter = 0

  addRealm(host: string, realm: Partial<FakeRealm> & { user: string }) {
    this.realms.set(host, {
      name: 'default',
      homeWorkspace: WS_A,
      members: [],
      workspaces: [],
      rotation: false,
      validRefreshTokens: new Set(),
      ...realm
    })
  }

  tokenRequests(host?: string) {
    return this.requests.filter((r) => r.url.pathname.endsWith('/token') && (!host || r.url.host === host))
  }

  backendRequests(host?: string) {
    return this.requests.filter((r) => r.url.pathname.startsWith('/_gw/') && (!host || r.url.host === host))
  }

  toolRequests(host?: string) {
    return this.backendRequests(host).filter((r) => !r.url.pathname.startsWith(DOCS_PATH))
  }

  docRequests(host?: string) {
    return this.backendRequests(host).filter((r) => r.url.pathname.startsWith(DOCS_PATH))
  }

  workspaceTokenRequests(host?: string) {
    return this.tokenRequests(host).filter((r) => r.form?.get('workspace_id'))
  }

  private issue(value: string) {
    this.issued.push(value)
    return value
  }

  private accessToken(host: string, realm: FakeRealm, workspaceId: string | undefined) {
    this.counter++
    const claims: Record<string, unknown> = {
      preferred_username: realm.user,
      iss: `https://${host}/auth/realms/x`,
      exp: this.now + this.tokenTtl,
      jti: `access-${this.counter}`
    }
    if (workspaceId !== undefined) claims.COLADA_WORKSPACE_ID = workspaceId
    return this.issue(jwt(claims))
  }

  private refreshToken(host: string, realm: FakeRealm) {
    this.counter++
    const value = this.issue(`refresh-${host}-${this.counter}-SECRETVALUE`)
    realm.validRefreshTokens.add(value)
    return value
  }

  seedRefreshToken(host: string, store: FakeStore) {
    const realm = this.realms.get(host)
    if (!realm) throw new Error(`no realm ${host}`)
    store.values.set(host, this.refreshToken(host, realm))
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/_gw/s-ecosystem/oauthclients/colada-mcp/config') return this.config(url.host, init)
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const form = typeof init?.body === 'string' ? new URLSearchParams(init.body) : null
    const body = typeof init?.body === 'string' ? init.body : null
    this.requests.push({ url, method: init?.method ?? 'GET', headers, form, body, redirect: init?.redirect })
    const realm = this.realms.get(url.host)
    if (!realm) throw new TypeError('fetch failed')
    if (url.pathname.endsWith('/protocol/openid-connect/token')) {
      if (this.tokenDelayMs) await new Promise((r) => setTimeout(r, this.tokenDelayMs))
      return this.token(url.host, realm, form ?? new URLSearchParams())
    }
    if (this.backendDelayMs) await new Promise((r) => setTimeout(r, this.backendDelayMs))
    return this.backend(url, realm, headers)
  }

  private config(host: string, init: RequestInit | undefined) {
    this.configRequests.push(host)
    if (init?.redirect !== 'error') throw new Error('config request must not follow redirects')
    const realm = this.realms.get(host)
    if (!realm) throw new TypeError('fetch failed')
    const status = this.configStatus.get(host)
    if (status) return json(status, undefined)
    return json(200, { 'auth-server-url': '/auth', realm: realm.name, resource: 'react-spa' })
  }

  private token(host: string, realm: FakeRealm, form: URLSearchParams) {
    if (form.get('grant_type') === 'authorization_code') {
      if (!form.get('code_verifier')) return json(400, { error: 'invalid_grant' })
      return json(200, {
        access_token: this.accessToken(host, realm, realm.homeWorkspace),
        refresh_token: this.refreshToken(host, realm)
      })
    }
    const presented = form.get('refresh_token') ?? ''
    if (!realm.validRefreshTokens.has(presented)) {
      return json(400, { error: 'invalid_grant', error_description: 'Token is not active SECRETDESC' })
    }
    const requested = form.get('workspace_id')
    const claim = requested && realm.members.includes(requested) ? requested : realm.homeWorkspace
    const body: Record<string, unknown> = { access_token: this.accessToken(host, realm, claim) }
    if (realm.rotation) {
      realm.validRefreshTokens.delete(presented)
      body.refresh_token = this.refreshToken(host, realm)
    } else {
      body.refresh_token = presented
    }
    return json(200, body)
  }

  private backend(url: URL, realm: FakeRealm, headers: Record<string, string>) {
    const token = (headers.authorization ?? '').replace(/^Bearer /, '')
    if (!this.issued.includes(token)) return json(401, undefined)
    const claims = claimsOf(token)
    if ((claims.exp as number) <= this.now) return json(401, undefined)
    const forced = this.backendStatus.get(url.pathname)
    if (forced) return json(forced, undefined)
    const raw = this.backendRaw.get(url.pathname)
    if (raw) return raw(url, headers)
    if (url.pathname === '/_gw/s-workspaces/api/workspaces') return json(200, realm.workspaces)
    const match = url.pathname.match(/^\/_gw\/s-events\/api\/events\/([^/]+)$/)
    if (match) {
      const event = this.events.get(String(claims.COLADA_WORKSPACE_ID))?.get(match[1] ?? '')
      return event === undefined ? json(404, undefined) : json(200, event)
    }
    return json(404, undefined)
  }
}

export interface Harness {
  world: FakeWorld
  store: FakeStore
  app: App
  client: Client
  opened: string[]
  hooks: { onOpen: ((url: string) => Promise<void>) | null }
  logs: CallLogEntry[]
  stderr: string[]
  call: (
    name: string,
    args?: Record<string, unknown>
  ) => Promise<{ isError: boolean; body: Record<string, unknown>; text: string }>
  completeLogin: (url?: string) => Promise<Response>
  close: () => Promise<void>
}

export const STAGE_HOST = 'stage-admin.colada365.com'

export async function createHarness(
  world: FakeWorld,
  hosts: string[] = [STAGE_HOST],
  store = new FakeStore(),
  allowPersonalData = false
): Promise<Harness> {
  const opened: string[] = []
  const logs: CallLogEntry[] = []
  const stderr: string[] = []
  const hooks: { onOpen: ((url: string) => Promise<void>) | null } = { onOpen: null }
  const app = new App({
    hosts,
    allowPersonalData,
    fetch: world.fetch,
    store,
    now: () => world.now,
    log: (message) => stderr.push(message),
    callLog: async (entry) => {
      logs.push(entry)
    },
    openBrowser: async (url) => {
      opened.push(url)
      await hooks.onOpen?.(url)
    }
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createServer(app)
  await server.connect(serverTransport)
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(clientTransport)

  return {
    world,
    store,
    app,
    client,
    opened,
    hooks,
    logs,
    stderr,
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args })
      const content = result.content as Array<{ type: string; text: string }>
      const text = content[0]?.text ?? ''
      return { isError: result.isError === true, body: JSON.parse(text), text }
    },
    async completeLogin(url = opened.at(-1)) {
      if (!url) throw new Error('no login was opened')
      const auth = new URL(url)
      const redirect = auth.searchParams.get('redirect_uri') ?? ''
      const state = auth.searchParams.get('state') ?? ''
      return globalThis.fetch(`${redirect}/?state=${encodeURIComponent(state)}&code=test-code`)
    },
    async close() {
      for (const { session } of app.openedRealms()) await session.logout()
      await client.close()
      await server.close()
    }
  }
}

export function workspace(id: string, name: string, authRealm = 'default') {
  return {
    id,
    name,
    authRealm,
    consrAuthRealm: 'consr',
    baseUrl: null,
    consrUrl: null,
    defaultLanguages: [],
    vatRate: 0
  }
}

export function eventPath(id: string) {
  return { service: 's-events', path: `/api/events/${id}` }
}
