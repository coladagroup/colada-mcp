import { isDeepStrictEqual } from 'node:util'
import { messages, ToolError } from '../../../errors.js'

export const NULL_ETAG = 'null_etag'
export const MAX_REAPPLIES = 3

export interface Versioned {
  value: unknown
  etag: string
}

export type PutResult = { saved: true } | { saved: false; conflict: Versioned }

export interface RtdbWriter {
  read(path: string): Promise<Versioned>
  put(path: string, value: unknown, ifMatch: string, retries: number): Promise<PutResult>
}

export async function conditionalWrite(
  writer: RtdbWriter,
  path: string,
  mutate: (current: unknown) => unknown,
  first?: Versioned
): Promise<{ value: unknown; retries: number; written: boolean }> {
  let current = first ?? (await writer.read(path))
  for (let retries = 0; retries <= MAX_REAPPLIES; retries++) {
    const next = mutate(structuredClone(current.value))
    if (isDeepStrictEqual(next, current.value)) return { value: next, retries, written: false }
    const result = await writer.put(path, next, current.etag, retries)
    if (result.saved) return { value: next, retries, written: true }
    current = result.conflict
  }
  throw new ToolError(messages.writeConflict(path, MAX_REAPPLIES + 1))
}
