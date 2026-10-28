import { type CallState, callBackend } from '../api/backend.js'
import type { ApiClient } from '../api/client.js'
import { decodeClaims, expiresAt } from '../auth/jwt.js'
import type { RealmSession } from '../auth/session.js'
import { messages, ToolError } from '../errors.js'
import { type FirebaseConfig, parseFirebaseConfig } from './config.js'
import type { FirebaseHttp } from './http.js'

export type FirebaseAppName = 'campaigns'

const MIN_VALIDITY_SECONDS = 60
const SIGN_IN_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken'

export interface FirebaseAccess {
  config: FirebaseConfig
  idToken: string
  exp: number
  uid: string
  roles: string[]
  permissions: ReadonlySet<string>
}

export class FirebaseSessions {
  private readonly cache = new Map<string, FirebaseAccess>()
  private readonly inflight = new Map<string, Promise<FirebaseAccess>>()
  private generation = 0

  constructor(
    private readonly api: ApiClient,
    private readonly http: FirebaseHttp,
    private readonly session: RealmSession,
    private readonly now: () => number
  ) {
    session.onEnd(() => this.clear())
  }

  access(workspaceId: string, app: FirebaseAppName, state: CallState): Promise<FirebaseAccess> {
    const key = `${workspaceId}:${app}`
    const cached = this.cache.get(key)
    if (cached && cached.exp - this.now() >= MIN_VALIDITY_SECONDS) return Promise.resolve(cached)
    const running = this.inflight.get(key)
    if (running) return running
    const generation = this.generation
    const request = this.mint(workspaceId, app, state)
      .then((access) => {
        if (generation !== this.generation) throw new ToolError(messages.loggedOut())
        this.cache.set(key, access)
        return access
      })
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, request)
    return request
  }

  drop(workspaceId: string, app: FirebaseAppName) {
    this.cache.delete(`${workspaceId}:${app}`)
  }

  clear() {
    this.generation++
    this.cache.clear()
  }

  private async mint(workspaceId: string, app: FirebaseAppName, state: CallState): Promise<FirebaseAccess> {
    const base = `/_gw/s-access/api/auth/integrations/${app}/firebase`
    const internal = {
      workspaceId,
      write: false,
      forbidden: messages.firebaseNoAccess(workspaceId),
      serverError: messages.firebaseNotSetUp(workspaceId)
    }
    const configResponse = await callBackend(this.api, this.session, { ...internal, path: `${base}/config` }, state)
    const config = parseFirebaseConfig(workspaceId, configResponse.body)
    const tokenResponse = await callBackend(
      this.api,
      this.session,
      { ...internal, method: 'POST', path: `${base}/token` },
      state
    )
    const customToken = (tokenResponse.body as { value?: unknown } | null)?.value
    if (typeof customToken !== 'string' || customToken === '') {
      throw new ToolError(messages.firebaseSignInFailed(tokenResponse.status, null))
    }
    const idToken = await this.signIn(config, customToken)
    const claims = decodeClaims(idToken)
    if (claims.COLADA_WORKSPACE_ID !== workspaceId) throw new ToolError(messages.firebaseOtherWorkspace())
    const keycloakClaims = decodeClaims(await this.session.workspaceToken(workspaceId))
    return {
      config,
      idToken,
      exp: expiresAt(claims),
      uid: typeof keycloakClaims.sub === 'string' ? keycloakClaims.sub : '',
      roles: Array.isArray(claims.roles) ? claims.roles.filter((role) => typeof role === 'string') : [],
      permissions: await this.permissions(workspaceId, state)
    }
  }

  private async signIn(config: FirebaseConfig, customToken: string): Promise<string> {
    const response = await this.http.request({
      url: `${SIGN_IN_URL}?key=${encodeURIComponent(config.apiKey)}`,
      method: 'POST',
      body: { token: customToken, returnSecureToken: true },
      store: 'Identity Toolkit',
      path: 'accounts:signInWithCustomToken',
      tooLarge: () => messages.firebaseSignInFailed(null, null)
    })
    const idToken = (response.body as { idToken?: unknown } | null)?.idToken
    if (response.status !== 200 || typeof idToken !== 'string' || idToken === '') {
      throw new ToolError(messages.firebaseSignInFailed(response.status, errorCode(response.body)))
    }
    return idToken
  }

  private async permissions(workspaceId: string, state: CallState): Promise<ReadonlySet<string>> {
    const response = await callBackend(
      this.api,
      this.session,
      { workspaceId, path: '/_gw/s-permissions/api/permissions/my' },
      state
    )
    if (!Array.isArray(response.body) || !response.body.every((item) => typeof item === 'string')) {
      throw new ToolError(messages.firebasePermissionsUnreadable(workspaceId))
    }
    return new Set(response.body)
  }
}

function errorCode(body: unknown): string | null {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message
  if (typeof message !== 'string') return null
  const code = message.split(' ')[0] ?? ''
  return /^[A-Z_]+$/.test(code) ? code : null
}
