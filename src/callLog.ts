import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface ApiCall {
  method: string
  service: string
  path: string
  query: Record<string, string>
  ifMatch: boolean
}

export interface FirebaseCall {
  app: string
  store: 'rtdb' | 'firestore'
  path: string
  query: Record<string, unknown>
}

interface CallLogBase {
  time: string
  realm: string | null
  user: string | null
  workspace: string | null
  tool: string
  httpStatus: number | null
}

export type CallLogEntry = CallLogBase & ({ params: unknown } | ApiCall | FirebaseCall)

export type CallLog = (entry: CallLogEntry) => Promise<void>

export const DEFAULT_CALL_LOG_PATH = join(homedir(), '.colada-mcp', 'calls.log')

export function fileCallLog(path = DEFAULT_CALL_LOG_PATH): CallLog {
  return async (entry) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  }
}
