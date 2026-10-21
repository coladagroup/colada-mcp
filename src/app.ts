import { ApiClient } from './api/client.js'
import { RealmSession, type SessionDeps } from './auth/session.js'
import type { CallLog } from './callLog.js'
import { type Env, hostOf, isRealm, REALMS, type Realm } from './config.js'
import { messages, ToolError } from './errors.js'
import { WorkspaceDirectory } from './workspaces.js'

export interface AppDeps extends SessionDeps {
  env: Env
  callLog: CallLog
}

export interface RealmContext {
  session: RealmSession
  directory: WorkspaceDirectory
}

export class App {
  readonly api: ApiClient
  private readonly realms = new Map<Realm, RealmContext>()

  constructor(readonly deps: AppDeps) {
    this.api = new ApiClient(deps.fetch)
  }

  realm(realm: string): RealmContext {
    if (!isRealm(realm)) throw new ToolError(messages.unknownRealm(realm))
    const existing = this.realms.get(realm)
    if (existing) return existing
    const host = hostOf(this.deps.env, realm)
    if (!host) throw new ToolError(messages.realmNotAvailable(realm, this.deps.env))
    const session = new RealmSession(realm, host, this.deps)
    const context = { session, directory: new WorkspaceDirectory(this.api, session) }
    this.realms.set(realm, context)
    return context
  }

  availableRealms(): Realm[] {
    return REALMS.filter((realm) => hostOf(this.deps.env, realm) !== undefined)
  }

  userOf(realm: string | null): string | null {
    return realm !== null && isRealm(realm) ? (this.realms.get(realm)?.session.user() ?? null) : null
  }
}
