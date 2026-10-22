import { ApiClient } from './api/client.js'
import { fetchRealm } from './api/realmConfig.js'
import { RealmSession, type SessionDeps } from './auth/session.js'
import type { CallLog } from './callLog.js'
import { messages, ToolError } from './errors.js'
import { WorkspaceDirectory } from './workspaces.js'

export interface AppDeps extends SessionDeps {
  hosts: string[]
  allowPersonalData: boolean
  callLog: CallLog
}

export interface RealmContext {
  session: RealmSession
  directory: WorkspaceDirectory
}

export class App {
  readonly api: ApiClient
  private readonly realms = new Map<string, RealmContext>()
  private realmNames: Promise<string[]> | null = null

  constructor(readonly deps: AppDeps) {
    this.api = new ApiClient(deps.fetch)
  }

  get multiRealm(): boolean {
    return this.deps.hosts.length > 1
  }

  async realm(name: string | undefined): Promise<RealmContext> {
    const names = await this.discoverRealms()
    const index = name ? names.indexOf(name) : 0
    const realm = names[index]
    const host = this.deps.hosts[index]
    if (realm === undefined || host === undefined) throw new ToolError(messages.unknownRealm(name ?? ''))
    const existing = this.realms.get(realm)
    if (existing) return existing
    const session = new RealmSession(realm, host, this.deps)
    const context = { session, directory: new WorkspaceDirectory(this.api, session) }
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
    if (duplicate !== undefined) throw new ToolError(messages.duplicateRealm(duplicate))
    return names
  }
}
