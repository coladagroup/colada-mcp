import { messages, ToolError } from '../errors.js'
import { decodeClaims, expiresAt, userOf } from './jwt.js'
import { type LoginDeps, type PendingLogin, startLogin } from './login.js'
import { postToken, type TokenResult } from './tokenEndpoint.js'
import type { TokenStore } from './tokenStore.js'

const MIN_VALIDITY_SECONDS = 30
const BASE_KEY = 'base'

export interface SessionDeps extends LoginDeps {
  store: TokenStore
  now: () => number
}

interface CachedToken {
  token: string
  exp: number
}

export class RealmSession {
  private readonly tokens = new Map<string, CachedToken>()
  private readonly inflight = new Map<string, Promise<string>>()
  private queue: Promise<unknown> = Promise.resolve()
  private login: PendingLogin | null = null
  private lastUser: string | null = null
  private readonly endListeners: Array<() => void> = []

  constructor(
    readonly realm: string,
    readonly host: string,
    private readonly deps: SessionDeps
  ) {}

  user(): string | null {
    return this.lastUser
  }

  onEnd(listener: () => void) {
    this.endListeners.push(listener)
  }

  baseToken(): Promise<string> {
    return this.token(BASE_KEY, null)
  }

  workspaceToken(workspaceId: string): Promise<string> {
    return this.token(`ws:${workspaceId}`, workspaceId)
  }

  invalidate(workspaceId: string | null) {
    this.tokens.delete(workspaceId === null ? BASE_KEY : `ws:${workspaceId}`)
  }

  async end(): Promise<never> {
    await this.clear()
    return this.beginLogin()
  }

  async logout(): Promise<string | null> {
    const user = this.lastUser
    this.login?.close()
    this.login = null
    await this.clear()
    this.lastUser = null
    return user
  }

  private async clear() {
    await this.deps.store.delete(this.host)
    this.tokens.clear()
    for (const listener of this.endListeners) listener()
  }

  private token(key: string, workspaceId: string | null): Promise<string> {
    if (this.login) return Promise.reject(new ToolError(messages.loginInProgress()))
    const cached = this.tokens.get(key)
    if (cached && cached.exp - this.deps.now() >= MIN_VALIDITY_SECONDS) return Promise.resolve(cached.token)
    const running = this.inflight.get(key)
    if (running) return running
    const request = this.serial(() => this.requestToken(key, workspaceId)).finally(() => this.inflight.delete(key))
    this.inflight.set(key, request)
    return request
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async requestToken(key: string, workspaceId: string | null): Promise<string> {
    const refreshToken = await this.deps.store.get(this.host)
    if (!refreshToken) return this.beginLogin()

    const params: Record<string, string> = { grant_type: 'refresh_token', refresh_token: refreshToken }
    if (workspaceId !== null) params.workspace_id = workspaceId

    let result: TokenResult
    try {
      result = await postToken(this.deps.fetch, this.host, this.realm, params)
    } catch {
      throw new ToolError(messages.keycloakUnreachable(this.host, null))
    }
    if (result.status === 400 && result.error === 'invalid_grant') return this.end()
    if (result.status !== 200 || !result.accessToken) {
      throw new ToolError(messages.keycloakUnreachable(this.host, result.status))
    }

    await this.accept(result)
    const claims = decodeClaims(result.accessToken)
    if (workspaceId !== null && claims.COLADA_WORKSPACE_ID !== workspaceId) {
      throw new ToolError(messages.noAccess(workspaceId, this.realm))
    }
    this.tokens.set(key, { token: result.accessToken, exp: expiresAt(claims) })
    return result.accessToken
  }

  private async accept(result: TokenResult) {
    if (result.refreshToken) await this.deps.store.set(this.host, result.refreshToken)
    if (result.accessToken) this.lastUser = userOf(decodeClaims(result.accessToken))
  }

  private async beginLogin(): Promise<never> {
    if (this.login) throw new ToolError(messages.loginInProgress())
    const login = await startLogin(
      this.host,
      this.realm,
      this.deps,
      async (result) => {
        await this.accept(result)
        if (result.accessToken) {
          this.tokens.set(BASE_KEY, { token: result.accessToken, exp: expiresAt(decodeClaims(result.accessToken)) })
        }
      },
      () => {
        if (this.login === login) this.login = null
      }
    )
    this.login = login
    throw new ToolError(messages.loginOpened(this.realm, this.host, login.opened ? undefined : login.url))
  }
}
