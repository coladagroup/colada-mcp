import { ApiClient } from './api/client.js'
import { fetchRealm } from './api/realmConfig.js'
import { RealmSession, type SessionDeps } from './auth/session.js'
import type { CallLog } from './callLog.js'
import { fail, messages } from './errors.js'
import { FirebaseHttp } from './firebase/http.js'
import { FirebaseSessions } from './firebase/session.js'
import { PreviewStore } from './preview.js'
import { CampaignsUsers } from './users.js'
import { WorkspaceDirectory } from './workspaces.js'

const SESSION_NOTICE_SECONDS = 30 * 60

export function isoTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

export interface AppDeps extends SessionDeps {
  hosts: string[]
  allowPersonalData: boolean
  callLog: CallLog
  pid: number
}

export interface RealmContext {
  session: RealmSession
  directory: WorkspaceDirectory
  firebase: FirebaseSessions
  users: CampaignsUsers
}

export class App {
  readonly api: ApiClient
  readonly firebaseHttp: FirebaseHttp
  readonly previews: PreviewStore
  private readonly realms = new Map<string, RealmContext>()
  private realmNames: Promise<string[]> | null = null
  private mainRealm: string | null = null
  client: string | null = null

  constructor(readonly deps: AppDeps) {
    this.api = new ApiClient(deps.fetch)
    this.firebaseHttp = new FirebaseHttp(this.api, deps.fetch)
    this.previews = new PreviewStore(deps.now)
  }

  get multiRealm(): boolean {
    return this.deps.hosts.length > 1
  }

  async realm(name: string | undefined): Promise<RealmContext> {
    const names = await this.discoverRealms()
    const index = name ? names.indexOf(name) : 0
    const realm = names[index]
    const host = this.deps.hosts[index]
    if (realm === undefined || host === undefined) throw fail.unknownRealm(name ?? '')
    const existing = this.realms.get(realm)
    if (existing) return existing
    const session = new RealmSession(realm, host, this.deps)
    const context = {
      session,
      directory: new WorkspaceDirectory(this.api, session),
      firebase: new FirebaseSessions(this.api, this.firebaseHttp, session, this.deps.now),
      users: new CampaignsUsers(this.api, session, this.deps.now)
    }
    this.realms.set(realm, context)
    return context
  }

  async allRealms(): Promise<RealmContext[]> {
    const names = await this.discoverRealms()
    return Promise.all(names.map((name) => this.realm(name)))
  }

  openedRealms(): RealmContext[] {
    return [...this.realms.values()]
  }

  sessionNotice(realm: string | null): string | null {
    const name = realm ?? this.mainRealm
    const endsAt = name !== null ? (this.realms.get(name)?.session.knownEndsAt() ?? null) : null
    if (endsAt === null) return null
    const left = endsAt - this.deps.now()
    if (left <= 0 || left > SESSION_NOTICE_SECONDS) return null
    return messages.sessionEndsSoon(isoTime(endsAt), Math.ceil(left / 60), this.deps.noBrowser === true)
  }

  userOf(realm: string | null): string | null {
    return realm !== null ? (this.realms.get(realm)?.session.user() ?? null) : null
  }

  private discoverRealms(): Promise<string[]> {
    this.realmNames ??= this.fetchRealmNames().catch((err) => {
      this.realmNames = null
      throw err
    })
    return this.realmNames
  }

  private async fetchRealmNames(): Promise<string[]> {
    const names = await Promise.all(this.deps.hosts.map((host) => fetchRealm(this.deps.fetch, host)))
    const duplicate = names.find((name, index) => names.indexOf(name) !== index)
    if (duplicate !== undefined) throw fail.duplicateRealm(duplicate)
    this.mainRealm = names[0] ?? null
    return names
  }
}
