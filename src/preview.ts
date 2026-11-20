import { createHash, randomUUID } from 'node:crypto'

export const PREVIEW_SECONDS = 10 * 60

export const PREVIEW_NOTE =
  'Preview: nothing was sent. Keys, offer numbers and ETags are not reserved: the real call reads fresh data, takes its own keys and can differ. To send it, call the tool again with the same input and this previewId (valid 10 minutes, works once; required on prod hosts).'

export function isProdHost(host: string): boolean {
  return !host.startsWith('stage-')
}

export function inputHash(tool: string, input: Record<string, unknown>): string {
  const { preview: _preview, previewId: _previewId, ...fields } = input
  return createHash('sha256')
    .update(JSON.stringify([tool, sorted(fields)]))
    .digest('hex')
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, sorted(item)])
  )
}

export class PreviewStore {
  private readonly entries = new Map<string, { hash: string; expiresAt: number }>()

  constructor(private readonly now: () => number) {}

  issue(hash: string): string {
    this.prune()
    const id = randomUUID()
    this.entries.set(id, { hash, expiresAt: this.now() + PREVIEW_SECONDS })
    return id
  }

  redeem(id: string | undefined, hash: string): boolean {
    this.prune()
    if (id === undefined) return false
    const entry = this.entries.get(id)
    if (entry === undefined || entry.hash !== hash) return false
    this.entries.delete(id)
    return true
  }

  private prune() {
    const now = this.now()
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt < now) this.entries.delete(id)
    }
  }
}
