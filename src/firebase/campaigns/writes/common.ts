import type { App } from '../../../app.js'
import { messages, ToolError } from '../../../errors.js'
import type { FirebaseWriteToolContext } from '../../../tools/run.js'
import { splitPath } from '../../policy/check.js'
import { campaignsRole } from '../../policy/rows.js'
import type { PlannedWrite, WriteTool } from '../../policy/writes.js'
import { type CampaignsWriter, openWriter } from '../../write.js'

export interface Target {
  realm?: string
  workspace?: string
}

export interface Session {
  writer: CampaignsWriter
  uid: string
  role: string
}

export function assertId(id: string) {
  if (splitPath(id).length !== 1) throw new ToolError(messages.firebasePath(id, 'the id must be one path segment'))
}

export function defined<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>
}

export async function open(
  app: App,
  ctx: FirebaseWriteToolContext,
  tool: WriteTool,
  target: Target,
  planned: PlannedWrite[]
): Promise<Session> {
  const writer = await openWriter(app, ctx, tool, target, planned)
  const access = await writer.access()
  return { writer, uid: access.uid, role: campaignsRole(access.roles) }
}

export function written(ctx: FirebaseWriteToolContext) {
  return ctx.writes
    .filter((write) => write.httpStatus !== null && write.httpStatus >= 200 && write.httpStatus < 300)
    .map((write) => ({ method: write.method, path: write.path }))
}

export function partial(
  ctx: FirebaseWriteToolContext,
  tool: WriteTool,
  notSaved: string[],
  state: string,
  err: unknown
): never {
  if (!(err instanceof ToolError)) throw err
  const saved = written(ctx).map((write) => write.path)
  if (saved.length === 0) throw err
  throw new ToolError(messages.writePartial(tool, saved, notSaved, `${state} Cause: ${err.message}`))
}

export function nowJson(app: App): string {
  return new Date(app.deps.now() * 1000).toJSON()
}
