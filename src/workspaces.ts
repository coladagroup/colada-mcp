import { type CallState, callBackend } from './api/backend.js'
import type { ApiClient } from './api/client.js'
import type { RealmSession } from './auth/session.js'
import { fail, ToolError } from './errors.js'

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

const MAX_LISTED = 10
const FULL_LIST = 'Call list_workspaces for the full list.'

function lines(workspaces: WorkspaceInfo[]): string {
  const listed = workspaces.slice(0, MAX_LISTED).map((w) => `${w.id} — ${w.name}`)
  if (workspaces.length > MAX_LISTED) listed.push(`… and ${workspaces.length - MAX_LISTED} more.`)
  return listed.join('\n')
}

function closeMatches(input: string, workspaces: WorkspaceInfo[]): WorkspaceInfo[] {
  const needle = input.trim().toLowerCase()
  if (needle === '') return []
  const contains = workspaces.filter((w) => w.name.toLowerCase().includes(needle))
  const prefix = needle.slice(0, 3)
  const sharePrefix = workspaces.filter((w) => !contains.includes(w) && w.name.toLowerCase().startsWith(prefix))
  return [...contains, ...sharePrefix]
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
    if (!Array.isArray(response.body)) throw fail.failed('GET', WORKSPACES_PATH, response.status)
    const items = response.body as Array<Record<string, unknown>>
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
      const close = closeMatches(input, this.cache ?? [])
      const candidates = close.length > 0 ? `Close matches:\n${lines(close)}` : 'No close matches.'
      throw new ToolError(
        `The "workspace" parameter "${input}" matches no workspace. ${candidates}\n${FULL_LIST}`,
        'refused',
        'workspaceNoMatch'
      )
    }
    throw new ToolError(
      `The "workspace" parameter "${input}" matches ${matches.length} workspaces; pass the id:\n${lines(matches)}${matches.length > MAX_LISTED ? `\n${FULL_LIST}` : ''}`,
      'refused',
      'workspaceAmbiguous'
    )
  }

  private async single(state: CallState): Promise<ResolvedWorkspace> {
    const workspaces = await this.list(state)
    const [only] = workspaces
    if (only && workspaces.length === 1) return { id: only.id, name: only.name }
    if (!only) throw fail.noWorkspace(this.session.realm)
    throw new ToolError(
      `Pass the "workspace" parameter: you have ${workspaces.length} workspaces. ${FULL_LIST}`,
      'refused',
      'workspaceRequired'
    )
  }
}
