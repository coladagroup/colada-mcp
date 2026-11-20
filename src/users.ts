import { callBackend } from './api/backend.js'
import type { ApiClient } from './api/client.js'
import type { RealmSession } from './auth/session.js'
import { fail, ToolError } from './errors.js'
import { MAX_RESPONSE_BYTES } from './policy/size.js'

export const CAMPAIGNS_ROLES = [
  'campaigns_app_super_admin',
  'campaigns_app_admin',
  'campaigns_app_planner',
  'campaigns_app_restricted_planner',
  'campaigns_app_approver',
  'campaigns_app_requester',
  'campaigns_app_speaker',
  'campaigns_app_service_manager',
  'campaigns_app_service_employee',
  'campaigns_app_finance_manager',
  'campaigns_app_finance_approver',
  'campaigns_app_controller',
  'campaigns_app_timesheet_reporter',
  'campaigns_app_collaborator'
]

const USERS_PATH = '/_gw/s-access/api/users'
const PAGE_SIZE = 100
const MAX_PAGES = 200
const CACHE_SECONDS = 600

interface KnownUsers {
  uids: Set<string>
  uidByEmail: Map<string, string>
}

type Loaded = KnownUsers | 'forbidden'

export class CampaignsUsers {
  private readonly cache = new Map<string, { loadedAt: number; users: Loaded }>()

  constructor(
    private readonly api: ApiClient,
    private readonly session: RealmSession,
    private readonly now: () => number
  ) {
    session.onEnd(() => this.cache.clear())
  }

  async resolve(workspaceId: string, field: string, value: string, callerUid: string): Promise<string> {
    const users = await this.load(workspaceId)
    if (users === 'forbidden') {
      if (value === callerUid) return value
      throw fail.usersListForbidden(field)
    }
    const uid = value.includes('@') ? users.uidByEmail.get(value.toLowerCase()) : users.uids.has(value) ? value : null
    if (uid === undefined || uid === null) throw fail.writeUnknownUser(field, workspaceId)
    return uid
  }

  private async load(workspaceId: string): Promise<Loaded> {
    const cached = this.cache.get(workspaceId)
    if (cached && this.now() - cached.loadedAt < CACHE_SECONDS) return cached.users
    const users = await this.fetchAll(workspaceId)
    this.cache.set(workspaceId, { loadedAt: this.now(), users })
    return users
  }

  private async fetchAll(workspaceId: string): Promise<Loaded> {
    const known: KnownUsers = { uids: new Set(), uidByEmail: new Map() }
    let total = Number.POSITIVE_INFINITY
    for (let page = 0; page < MAX_PAGES && page * PAGE_SIZE < total; page++) {
      const start = page * PAGE_SIZE
      let response: Awaited<ReturnType<typeof callBackend>>
      try {
        response = await callBackend(
          this.api,
          this.session,
          {
            workspaceId,
            path: USERS_PATH,
            // s-access returns end - start users for "users start-end", so the end here is exclusive
            headers: { Range: `users ${start}-${start + PAGE_SIZE}` },
            maxBytes: MAX_RESPONSE_BYTES
          },
          { httpStatus: null }
        )
      } catch (err) {
        if (err instanceof ToolError && err.reason === 'forbidden') return 'forbidden'
        throw err
      }
      const items = Array.isArray(response.body) ? response.body : []
      for (const item of items) addUser(known, item)
      total = totalOf(response.returnedHeaders['Content-Range']) ?? start + items.length
      if (items.length === 0) break
    }
    return known
  }
}

function addUser(known: KnownUsers, item: unknown) {
  if (item === null || typeof item !== 'object') return
  const { uid, email, assignedRoles } = item as Record<string, unknown>
  if (typeof uid !== 'string' || !Array.isArray(assignedRoles)) return
  if (!assignedRoles.some((role) => CAMPAIGNS_ROLES.includes(role as string))) return
  known.uids.add(uid)
  if (typeof email === 'string') known.uidByEmail.set(email.toLowerCase(), uid)
}

function totalOf(contentRange: string | undefined): number | null {
  const match = /\/(\d+)$/.exec(contentRange ?? '')
  return match ? Number(match[1]) : null
}
