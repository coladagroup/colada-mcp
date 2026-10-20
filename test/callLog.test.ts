import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileCallLog } from '../src/callLog.js'

describe('call log file', () => {
  it('AC14: appends one JSON line per call; directory 700, file 600', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'colada-mcp-')), '.colada-mcp')
    const path = join(dir, 'calls.log')
    const log = fileCallLog(path)
    const entry = {
      time: '2026-10-20T12:00:00.000Z',
      realm: 'default',
      user: 'frank',
      workspace: null,
      tool: 'list_workspaces',
      params: {},
      httpStatus: 200
    }
    await log(entry)
    await log({ ...entry, tool: 'logout', httpStatus: null })

    const lines = (await readFile(path, 'utf8')).trim().split('\n')
    expect(lines.map((line) => JSON.parse(line).tool)).toEqual(['list_workspaces', 'logout'])
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
})
