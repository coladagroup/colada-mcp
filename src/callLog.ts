import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface CallLogEntry {
  time: string
  realm: string | null
  user: string | null
  workspace: string | null
  tool: string
  params: unknown
  httpStatus: number | null
}

export type CallLog = (entry: CallLogEntry) => Promise<void>

export const DEFAULT_CALL_LOG_PATH = join(homedir(), '.colada-mcp', 'calls.log')

export function fileCallLog(path = DEFAULT_CALL_LOG_PATH): CallLog {
  return async (entry) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  }
}
