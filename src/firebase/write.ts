import type { App } from '../app.js'
import { messages, ToolError } from '../errors.js'
import type { FirebaseWriteToolContext, WriteRecord } from '../tools/run.js'
import { NULL_ETAG, type PutResult, type RtdbWriter, type Versioned } from './campaigns/writes/conditional.js'
import type { FirebaseMethod, FirebaseResponse } from './http.js'
import { checkFirebaseWrite, checkWritePermission, type WriteTool } from './policy/writes.js'
import { openReader, upstreamText } from './read.js'
import type { FirebaseAccess } from './session.js'

export interface CampaignsWriter extends RtdbWriter {
  workspace: string
  access: () => Promise<FirebaseAccess>
  patch(path: string, body: Record<string, unknown>): Promise<void>
}

const ETAG_HEADER = { 'X-Firebase-ETag': 'true' }

export async function openWriter(
  app: App,
  ctx: FirebaseWriteToolContext,
  tool: WriteTool,
  target: { realm?: string; workspace?: string }
): Promise<CampaignsWriter> {
  const reader = await openReader(app, ctx, { ...target, app: 'campaigns', path: '' })
  const access = await reader.access()
  checkWritePermission(tool, access.permissions, reader.workspace)
  const rootPath = (path: string) => (path.startsWith('/') ? path.slice(1) : `workspaces/${reader.workspace}/${path}`)

  const read = async (path: string): Promise<Versioned> => {
    const response = await reader.send(
      (used) =>
        app.firebaseHttp.request({
          url: rtdbUrl(used, rootPath(path)),
          headers: ETAG_HEADER,
          store: 'rtdb',
          path,
          tooLarge: () => messages.firebaseTooLarge('rtdb', path, '')
        }),
      'rtdb',
      path
    )
    return { value: response.body, etag: response.headers?.get('etag') ?? NULL_ETAG }
  }

  const write = async (
    method: FirebaseMethod,
    path: string,
    body: unknown,
    record: Omit<WriteRecord, 'httpStatus' | 'app' | 'store' | 'method'>,
    ifMatch: string | null
  ): Promise<FirebaseResponse> => {
    const used = await reader.access()
    checkFirebaseWrite(
      tool,
      { method, path: path === '' ? '' : rootPath(path), body: rootBody(path, body) },
      {
        workspace: reader.workspace,
        uid: used.uid
      }
    )
    const entry: WriteRecord = { app: 'campaigns', store: 'rtdb', method, ...record, httpStatus: null }
    ctx.writes.push(entry)
    const shown = record.path
    const send = (current: FirebaseAccess) =>
      app.firebaseHttp.request({
        url: rtdbUrl(current, path === '' ? '' : rootPath(path)),
        method,
        headers: ifMatch === null ? undefined : { 'if-match': ifMatch },
        body: path === '' ? rootBody(path, body) : body,
        write: true,
        store: 'rtdb',
        path: shown,
        tooLarge: () => messages.firebaseTooLarge('rtdb', shown, '')
      })
    let response = await send(used)
    entry.httpStatus = response.status
    ctx.state.httpStatus = response.status
    if (response.status === 401) {
      response = await send(await reader.renew())
      entry.httpStatus = response.status
      ctx.state.httpStatus = response.status
    }
    if (response.status === 401 || response.status === 403) throw new ToolError(messages.writeRefused(shown))
    if (response.conflict) return response
    if (response.status < 200 || response.status >= 300) {
      throw new ToolError(messages.writeFailed(method, shown, response.status, upstreamText(response)))
    }
    return response
  }

  return {
    workspace: reader.workspace,
    access: reader.access,
    read,
    async put(path, value, ifMatch, retries): Promise<PutResult> {
      const response = await write('PUT', path, value, { path, paths: null, ifMatch: true, retries }, ifMatch)
      return response.conflict ? { saved: false, conflict: response.conflict } : { saved: true }
    },
    async patch(path, body) {
      const record = path === '' ? { path: '/', paths: Object.keys(body) } : { path, paths: null }
      await write('PATCH', path, body, { ...record, ifMatch: false, retries: 0 }, null)
    }
  }

  function rootBody(path: string, body: unknown): unknown {
    if (path !== '' || body === null || typeof body !== 'object') return body
    return Object.fromEntries(Object.entries(body).map(([key, value]) => [rootPath(key), value]))
  }
}

function rtdbUrl(access: FirebaseAccess, rootPath: string): string {
  const path = rootPath === '' ? '' : rootPath.split('/').map(encodeURIComponent).join('/')
  return `https://${access.config.databaseHost}/${path}.json?auth=${encodeURIComponent(access.idToken)}`
}
