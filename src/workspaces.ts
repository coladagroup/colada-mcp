import { type CallState, callBackend } from './api/backend.js'
import type { ApiClient } from './api/client.js'
import type { RealmSession } from './auth/session.js'
import { messages, ToolError } from './errors.js'

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const WORKSPACES_PATH = '/_gw/s-workspaces/api/workspaces'

export interface WorkspaceInfo {
  id: string
  name: string
  realm: string
}

export interface ResolvedWorkspace {
  id: string
  name: string | null
}

function lines(workspaces: WorkspaceInfo[]): string {
  return workspaces.map((w) => `${w.id} — ${w.name}`).join('\n')
}

export class WorkspaceDirectory {
  private cache: WorkspaceInfo[] | null = null

  constructor(
    private readonly api: ApiClient,
    private readonly session: RealmSession
  ) {
    session.onEnd(() => this.clear())
  }

  clear() {
    this.cache = null
  }

  async list(state: CallState, refresh = false): Promise<WorkspaceInfo[]> {
    if (this.cache && !refresh) return this.cache
    const response = await callBackend(this.api, this.session, { workspaceId: null, path: WORKSPACES_PATH }, state)
    const items = Array.isArray(response.body) ? (response.body as Array<Record<string, unknown>>) : []
    this.cache = items
      .filter((item) => item.authRealm === this.session.realm && typeof item.id === 'string')
      .map((item) => ({ id: item.id as string, name: String(item.name ?? ''), realm: this.session.realm }))
    return this.cache
  }

  async resolve(input: string | undefined, state: CallState): Promise<ResolvedWorkspace> {
    if (input === undefined || input === '') return this.single(state)
    if (UUID.test(input)) {
      return { id: input, name: this.cache?.find((w) => w.id === input)?.name ?? null }
    }
    const fromCache = this.cache !== null
    let matches = (await this.list(state)).filter((w) => w.name === input)
    if (matches.length === 0 && fromCache) matches = (await this.list(state, true)).filter((w) => w.name === input)
    const [match] = matches
    if (match && matches.length === 1) return { id: match.id, name: match.name }
    if (matches.length === 0) {
      throw new ToolError(`Workspace "${input}" matches no workspace. Your workspaces:\n${lines(this.cache ?? [])}`)
    }
    throw new ToolError(`Workspace "${input}" matches ${matches.length} workspaces:\n${lines(matches)}`)
  }

  private async single(state: CallState): Promise<ResolvedWorkspace> {
    const workspaces = await this.list(state)
    const [only] = workspaces
    if (only && workspaces.length === 1) return { id: only.id, name: only.name }
    if (!only) throw new ToolError(messages.noWorkspace(this.session.realm))
    throw new ToolError(`Pass "workspace": you have ${workspaces.length} workspaces:\n${lines(workspaces)}`)
  }
}
