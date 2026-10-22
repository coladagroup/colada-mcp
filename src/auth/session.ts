import { messages, ToolError } from '../errors.js'
import { decodeClaims, expiresAt, userOf } from './jwt.js'
import { type LoginDeps, startLogin } from './login.js'
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

interface LoginAttempt {
  close: () => void
}

export class RealmSession {
  private readonly tokens = new Map<string, CachedToken>()
  private readonly inflight = new Map<string, Promise<string>>()
  private queue: Promise<unknown> = Promise.resolve()
  private login: LoginAttempt | null = null
  private generation = 0
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

  baseToken(minValidity = MIN_VALIDITY_SECONDS): Promise<string> {
    return this.token(BASE_KEY, null, minValidity)
  }

  workspaceToken(workspaceId: string, minValidity = MIN_VALIDITY_SECONDS): Promise<string> {
    return this.token(`ws:${workspaceId}`, workspaceId, minValidity)
  }

  invalidate(workspaceId: string | null) {
    this.tokens.delete(workspaceId === null ? BASE_KEY : `ws:${workspaceId}`)
  }

  async end(): Promise<never> {
    if (this.login) throw new ToolError(messages.loginInProgress())
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
    this.forget()
    await this.deps.store.delete(this.host)
  }

  private forget() {
    this.generation++
    this.tokens.clear()
    for (const listener of this.endListeners) listener()
  }

  private token(key: string, workspaceId: string | null, minValidity: number): Promise<string> {
    if (this.login) return Promise.reject(new ToolError(messages.loginInProgress()))
    const cached = this.tokens.get(key)
    if (cached && cached.exp - this.deps.now() >= minValidity) return Promise.resolve(cached.token)
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
    if (this.login) throw new ToolError(messages.loginInProgress())
    const generation = this.generation
    let refreshToken = await this.deps.store.get(this.host)
    if (!refreshToken) {
      this.forget()
      return this.beginLogin()
    }

    let result = await this.refresh(refreshToken, workspaceId)
    if (result.status === 400 && result.error === 'invalid_grant') {
      const newer = await this.deps.store.get(this.host)
      if (!newer || newer === refreshToken) return this.end()
      refreshToken = newer
      result = await this.refresh(refreshToken, workspaceId)
      if (result.status === 400 && result.error === 'invalid_grant') return this.end()
    }
    if (result.status >= 400 && result.status < 500) {
      throw new ToolError(messages.keycloakRefused(this.host, result.status))
    }
    if (result.status !== 200 || !result.accessToken) {
      throw new ToolError(messages.keycloakUnreachable(this.host, result.status))
    }
    if (generation !== this.generation) throw new ToolError(messages.loggedOut())

    await this.accept(result, generation)
    const claims = decodeClaims(result.accessToken)
    if (workspaceId !== null && claims.COLADA_WORKSPACE_ID !== workspaceId) {
      throw new ToolError(messages.noAccess(workspaceId, this.realm))
    }
    this.tokens.set(key, { token: result.accessToken, exp: expiresAt(claims) })
    return result.accessToken
  }

  private async refresh(refreshToken: string, workspaceId: string | null): Promise<TokenResult> {
    const params: Record<string, string> = { grant_type: 'refresh_token', refresh_token: refreshToken }
    if (workspaceId !== null) params.workspace_id = workspaceId
    try {
      return await postToken(this.deps.fetch, this.host, this.realm, params)
    } catch {
      throw new ToolError(messages.keycloakUnreachable(this.host, null))
    }
  }

  private async accept(result: TokenResult, generation: number) {
    if (result.refreshToken) {
      await this.deps.store.set(this.host, result.refreshToken)
      if (generation !== this.generation) {
        await this.deps.store.delete(this.host)
        throw new ToolError(messages.loggedOut())
      }
    }
    if (result.accessToken) this.lastUser = userOf(decodeClaims(result.accessToken))
  }

  private async beginLogin(): Promise<never> {
    if (this.login) throw new ToolError(messages.loginInProgress())
    const generation = this.generation
    const attempt: LoginAttempt = { close: () => undefined }
    this.login = attempt
    const active = () => this.login === attempt && this.generation === generation
    let login: Awaited<ReturnType<typeof startLogin>>
    try {
      login = await startLogin(
        this.host,
        this.realm,
        this.deps,
        async (result) => {
          if (!active()) return
          await this.accept(result, generation)
          if (result.accessToken) {
            this.tokens.set(BASE_KEY, { token: result.accessToken, exp: expiresAt(decodeClaims(result.accessToken)) })
          }
        },
        () => {
          if (this.login === attempt) this.login = null
        }
      )
    } catch (err) {
      if (this.login === attempt) this.login = null
      throw err
    }
    if (this.generation !== generation) {
      login.close()
      throw new ToolError(messages.loggedOut())
    }
    attempt.close = login.close
    throw new ToolError(messages.loginOpened(this.realm, this.host, login.url))
  }
}
