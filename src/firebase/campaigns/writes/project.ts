import type { App } from '../../../app.js'
import { fail } from '../../../errors.js'
import type { FirebaseWriteToolContext } from '../../../tools/run.js'
import { isHiddenProject } from '../../policy/rows.js'
import type { PlannedWrite, WriteTool } from '../../policy/writes.js'
import { assertId, defined, nowJson, open, type Target, written } from './common.js'

export const UPDATE_PROJECT: WriteTool = 'campaigns_update_project'

export const PROJECT_TYPES = ['service', 'development', 'event', 'internal', 'support'] as const
export const PROJECT_STATUSES = ['paid', 'inProgress', 'toBeInvoiced'] as const

export interface ProjectInput extends Target {
  project: string
  status?: string
  type?: string
}

export async function updateProject(app: App, ctx: FirebaseWriteToolContext, input: ProjectInput) {
  const { project } = input
  assertId(project)
  const fields = defined({ status: input.status, type: input.type })
  if (Object.keys(fields).length === 0) throw fail.writeNoFields('project')
  const planned: PlannedWrite[] = [...Object.keys(fields), 'updatedAt'].map((field) => ({
    method: 'PATCH',
    path: `projects/${project}/${field}`
  }))
  const session = await open(app, ctx, UPDATE_PROJECT, input, planned)
  const stored = (await session.writer.read(`projects/${project}`)).value
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    throw fail.writeMissingReference('Project', project, session.writer.workspace)
  }
  if (isHiddenProject(stored, session.uid, session.role)) throw fail.writeHidden('Project', project)
  const record = stored as Record<string, unknown>
  if (record.archived) throw fail.writeProjectArchived(project)

  const body: Record<string, unknown> = {}
  for (const [field, value] of Object.entries({ ...fields, updatedAt: nowJson(app) })) {
    body[`projects/${project}/${field}`] = value
  }
  await session.writer.patch('', body)
  const changed = Object.keys(fields).filter((field) => record[field] !== fields[field as keyof typeof fields])
  return {
    project,
    changed,
    before: Object.fromEntries(Object.keys(fields).map((field) => [field, record[field] ?? ''])),
    written: written(ctx)
  }
}
