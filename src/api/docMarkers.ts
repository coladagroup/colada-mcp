import type { RealmSession } from '../auth/session.js'
import { ResponseTooLargeError } from '../errors.js'
import { indexDoc, type MarkerIndex } from '../policy/markers.js'
import { MAX_RESPONSE_BYTES } from '../policy/size.js'
import type { ApiClient } from './client.js'

export const DOCS_SERVICE = 's-ecosystem'
export const CATALOG_PATH = '/api/api-docs'
export const DOC_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/

const RELOAD_AFTER_SECONDS = 3600

export interface ServiceDocs {
  service: string
  docs: Array<{ name: string; path: string; description?: string }>
}

interface Slot<T> {
  good?: T
  nextAttempt: number
  running?: Promise<void>
}

class LoadFailure extends Error {}

export class DocMarkers {
  private readonly catalogs = new Map<string, Slot<ServiceDocs[]>>()
  private readonly services = new Map<string, Slot<MarkerIndex>>()

  constructor(
    private readonly api: ApiClient,
    private readonly now: () => number,
    private readonly log: (message: string) => void
  ) {}

  async forService(session: RealmSession, service: string): Promise<MarkerIndex | undefined> {
    const slot = slotOf(this.services, `${session.host} ${service}`)
    await this.attemptIfDue(slot, async () => {
      const token = await session.baseToken()
      slot.nextAttempt = this.now() + RELOAD_AFTER_SECONDS
      this.log(`colada-mcp: markers ${service}: ${await this.loadService(session.host, token, service, slot)}`)
    })
    return slot.good
  }

  private async loadService(host: string, token: string, service: string, slot: Slot<MarkerIndex>): Promise<string> {
    try {
      const entry = (await this.catalog(host, token)).find((item) => item.service === service)
      if (!entry) {
        slot.good = []
        return 'no doc'
      }
      const index: MarkerIndex[number][] = []
      for (const { name } of entry.docs) {
        if (typeof name !== 'string' || !DOC_NAME.test(name)) throw new LoadFailure('failed doc name')
        const path = `${CATALOG_PATH}/${encodeURIComponent(service)}/${encodeURIComponent(name)}`
        index.push(...indexOf(await this.get(host, token, path)))
      }
      slot.good = index
      return `ok ${index.length} operations`
    } catch (err) {
      if (err instanceof LoadFailure) return err.message
      if (err instanceof ResponseTooLargeError) return 'failed too large'
      return 'failed network'
    }
  }

  private async catalog(host: string, token: string): Promise<ServiceDocs[]> {
    const slot = slotOf(this.catalogs, host)
    await this.attemptIfDue(slot, async () => {
      slot.nextAttempt = this.now() + RELOAD_AFTER_SECONDS
      const body = await this.get(host, token, CATALOG_PATH).catch(() => undefined)
      if (isCatalog(body)) slot.good = body
    })
    if (!slot.good) throw new LoadFailure('failed catalog')
    return slot.good
  }

  private async attemptIfDue(slot: Slot<unknown>, attempt: () => Promise<void>) {
    if (!slot.running && this.now() >= slot.nextAttempt) {
      slot.running = attempt().finally(() => {
        slot.running = undefined
      })
    }
    await slot.running
  }

  private async get(host: string, token: string, path: string): Promise<unknown> {
    const response = await this.api.request(
      'GET',
      host,
      `/_gw/${DOCS_SERVICE}${path}`,
      token,
      {},
      {
        maxBytes: MAX_RESPONSE_BYTES
      }
    )
    if (response.status !== 200) throw new LoadFailure(`failed http ${response.status}`)
    return response.body
  }
}

function indexOf(body: unknown): MarkerIndex {
  if (typeof body !== 'string') throw new LoadFailure('failed yaml')
  try {
    return indexDoc(body)
  } catch {
    throw new LoadFailure('failed yaml')
  }
}

function isCatalog(body: unknown): body is ServiceDocs[] {
  return Array.isArray(body) && body.every((item) => typeof item?.service === 'string' && Array.isArray(item?.docs))
}

function slotOf<T>(slots: Map<string, Slot<T>>, key: string): Slot<T> {
  let slot = slots.get(key)
  if (!slot) {
    slot = { nextAttempt: 0 }
    slots.set(key, slot)
  }
  return slot
}
