import {
  claimsOf,
  createHarness,
  FakeWorld,
  type Harness,
  json,
  jwt,
  STAGE_HOST,
  WS_A,
  WS_B,
  workspace
} from './harness.js'

export const DB_HOST = 'fake-campaigns-default-rtdb.europe-west1.firebasedatabase.app'
export const FIRESTORE_HOST = 'firestore.googleapis.com'
export const IDENTITY_HOST = 'identitytoolkit.googleapis.com'
export const API_KEY = 'AIzaFAKEKEY000000000000000000000000000'
export const ME = 'id-frank'
const CUSTOM_TOKEN = 'custom-token-SECRETCUSTOM'
const INDEXES: Record<string, string[]> = {
  timesheet: ['owner', 'project'],
  projects: ['account', 'owner', 'archived', 'guestsEventId']
}

export interface FirebaseWorld {
  world: FakeWorld
  rtdb: Record<string, Record<string, unknown>>
  firestore: Record<string, Record<string, Record<string, unknown>>>
  permissions: string[]
  roles: string[]
  idTokens: string[]
  rtdbStatus: number[]
  rtdbRaw: ((url: URL) => Response | undefined) | null
  firestoreRaw: ((url: URL) => Response | undefined) | null
}

function nodeAt(root: unknown, segments: string[]): unknown {
  let current = root
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return null
    current = (current as Record<string, unknown>)[segment]
    if (current === undefined) return null
  }
  return current ?? null
}

function rtdbAnswer(fw: FirebaseWorld, url: URL): Response {
  const token = url.searchParams.get('auth') ?? ''
  if (!fw.idTokens.includes(token)) return json(401, { error: 'Auth token is expired' })
  const claims = claimsOf(token)
  if ((claims.exp as number) <= fw.world.now) return json(401, { error: 'Auth token is expired' })
  const forced = fw.rtdbStatus.shift()
  if (forced) return json(forced, { error: forced === 401 ? 'Auth token is expired' : 'forced' })
  const segments = decodeURIComponent(url.pathname.replace(/\.json$/, ''))
    .split('/')
    .filter(Boolean)
  const [root, ws, node] = segments
  if (root !== 'workspaces' || ws !== claims.COLADA_WORKSPACE_ID || node === undefined) {
    return json(401, { error: 'Permission denied' })
  }
  if (node === 'secrets') return json(401, { error: 'Permission denied' })
  let value = nodeAt(fw.rtdb[ws ?? ''] ?? {}, segments.slice(2))
  const params = url.searchParams
  if (params.get('shallow') === 'true') {
    if ([...params.keys()].some((k) => k !== 'shallow' && k !== 'auth')) {
      return json(400, { error: 'Mixes query parameters with a shallow GET' })
    }
    const shallow =
      value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).map((k) => [k, true])) : value
    return json(200, shallow)
  }
  const orderBy = params.get('orderBy')
  if (orderBy !== null && value !== null && typeof value === 'object') {
    const child = JSON.parse(orderBy) as string
    if (child !== '$key' && !(INDEXES[node] ?? []).includes(child)) {
      return json(400, {
        error: `Index not defined, add ".indexOn": "${child}", for path "/workspaces/${ws}/${node}", to the rules`
      })
    }
    const pick = (key: string, record: unknown) =>
      child === '$key' ? key : (record as Record<string, unknown> | null)?.[child]
    let entries = Object.entries(value as Record<string, unknown>)
    const equalTo = params.get('equalTo')
    if (equalTo !== null) entries = entries.filter(([k, r]) => pick(k, r) === JSON.parse(equalTo))
    const startAt = params.get('startAt')
    if (startAt !== null) entries = entries.filter(([k, r]) => String(pick(k, r)) >= String(JSON.parse(startAt)))
    const endAt = params.get('endAt')
    if (endAt !== null) entries = entries.filter(([k, r]) => String(pick(k, r)) <= String(JSON.parse(endAt)))
    entries.sort(([ka, ra], [kb, rb]) => String(pick(ka, ra)).localeCompare(String(pick(kb, rb))))
    const first = params.get('limitToFirst')
    if (first !== null) entries = entries.slice(0, Number(first))
    const last = params.get('limitToLast')
    if (last !== null) entries = entries.slice(-Number(last))
    value = Object.fromEntries(entries.reverse())
  }
  return json(200, value)
}

export function typed(value: unknown): Record<string, unknown> {
  if (value === null) return { nullValue: null }
  if (typeof value === 'boolean') return { booleanValue: value }
  if (typeof value === 'number')
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value }
  if (typeof value === 'string') return { stringValue: value }
  if (Array.isArray(value)) return { arrayValue: value.length ? { values: value.map(typed) } : {} }
  const fields = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, typed(v)]))
  return { mapValue: Object.keys(fields).length ? { fields } : {} }
}

function firestoreAnswer(fw: FirebaseWorld, url: URL, headers: Record<string, string>): Response {
  const token = (headers.authorization ?? '').replace(/^Bearer /, '')
  if (!fw.idTokens.includes(token)) return json(401, { error: { code: 401, message: 'UNAUTHENTICATED' } })
  const raw = fw.firestoreRaw?.(url)
  if (raw) return raw
  const claims = claimsOf(token)
  const match = url.pathname.match(
    /^\/v1\/projects\/fake-campaigns\/databases\/\(default\)\/documents\/workspaces\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/
  )
  if (!match || match[1] !== claims.COLADA_WORKSPACE_ID)
    return json(403, { error: { code: 403, message: 'PERMISSION_DENIED' } })
  const [, ws, collection, id] = match
  const docs = fw.firestore[ws ?? '']?.[collection ?? ''] ?? {}
  const mask = url.searchParams.getAll('mask.fieldPaths')
  const toDoc = (docId: string, data: Record<string, unknown>) => {
    const picked = mask.length ? Object.fromEntries(Object.entries(data).filter(([k]) => mask.includes(k))) : data
    return {
      name: `projects/fake-campaigns/databases/(default)/documents/workspaces/${ws}/${collection}/${docId}`,
      fields: (typed(picked) as { mapValue: { fields?: unknown } }).mapValue.fields,
      updateTime: '2026-10-01T10:00:00Z'
    }
  }
  if (id !== undefined) {
    const doc = docs[id]
    return doc
      ? json(200, toDoc(id, doc as Record<string, unknown>))
      : json(404, { error: { code: 404, message: 'NOT_FOUND' } })
  }
  const ids = Object.keys(docs).sort()
  const start = Number(url.searchParams.get('pageToken') ?? 0)
  const size = Number(url.searchParams.get('pageSize') ?? 20)
  const page = ids.slice(start, start + size)
  if (page.length === 0) return json(200, {})
  return json(200, {
    documents: page.map((docId) => toDoc(docId, docs[docId] as Record<string, unknown>)),
    ...(start + size < ids.length ? { nextPageToken: String(start + size) } : {})
  })
}

export async function firebaseSetup(options: { allowPersonalData?: boolean } = {}) {
  const world = new FakeWorld()
  world.addRealm(STAGE_HOST, {
    user: 'frank',
    members: [WS_A, WS_B],
    workspaces: [workspace(WS_A, 'Alpha'), workspace(WS_B, 'Beta')]
  })
  const fw: FirebaseWorld = {
    world,
    rtdb: {},
    firestore: {},
    permissions: ['campaigns_app:view', 'campaigns_app/reports:view'],
    roles: ['campaigns_app_planner'],
    idTokens: [],
    rtdbStatus: [],
    rtdbRaw: null,
    firestoreRaw: null
  }
  let lastWorkspace = ''
  world.backendRaw.set('/_gw/s-access/api/auth/integrations/campaigns/firebase/config', (_url, headers) => {
    lastWorkspace = String(claimsOf((headers.authorization ?? '').replace(/^Bearer /, '')).COLADA_WORKSPACE_ID)
    return json(200, { apiKey: API_KEY, databaseURL: `https://${DB_HOST}`, projectId: 'fake-campaigns' })
  })
  world.backendRaw.set('/_gw/s-access/api/auth/integrations/campaigns/firebase/token', () =>
    json(200, { value: CUSTOM_TOKEN })
  )
  world.backendRaw.set('/_gw/s-permissions/api/permissions/my', () => json(200, fw.permissions))
  world.externalRaw.set(IDENTITY_HOST, () => {
    const idToken = jwt({
      sub: ME,
      user_id: ME,
      exp: world.now + 3600,
      COLADA_WORKSPACE_ID: lastWorkspace,
      roles: fw.roles
    })
    fw.idTokens.push(idToken)
    return json(200, { idToken, refreshToken: 'firebase-refresh-SECRET', expiresIn: '3600' })
  })
  world.externalRaw.set(DB_HOST, (url) => fw.rtdbRaw?.(url) ?? rtdbAnswer(fw, url))
  world.externalRaw.set(FIRESTORE_HOST, (url, init) =>
    firestoreAnswer(fw, url, Object.fromEntries(new Headers(init?.headers).entries()))
  )
  const h: Harness = await createHarness(world, [STAGE_HOST], undefined, options.allowPersonalData ?? false)
  world.seedRefreshToken(STAGE_HOST, h.store)
  return { h, fw, world }
}

export function rtdbRequests(world: FakeWorld) {
  return world.requests.filter((r) => r.url.host === DB_HOST)
}

export function firestoreRequests(world: FakeWorld) {
  return world.requests.filter((r) => r.url.host === FIRESTORE_HOST)
}
