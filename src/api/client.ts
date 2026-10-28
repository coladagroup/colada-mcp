import { messages, ResponseTooLargeError, ToolError } from '../errors.js'

export interface ApiResponse {
  status: number
  headers: Headers
  body: unknown
  bodyNote?: string
  errorText?: string
}

export interface RequestOptions {
  body?: unknown
  maxBytes?: number
  onStatus?: (status: number) => void
  write?: boolean
}

type BodyResult = { body: unknown } | { reason: string; error: ToolError }

export const MAX_WRITES_PER_MINUTE = 60
export const MAX_CONCURRENT_REQUESTS = 4

export class ApiClient {
  private readonly writeTimes: number[] = []
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly timeoutMs = 30_000,
    private readonly now: () => number = Date.now
  ) {}

  async request(
    method: string,
    host: string,
    pathAndQuery: string,
    token: string,
    headers: Record<string, string> = {},
    options: RequestOptions = {}
  ): Promise<ApiResponse> {
    return this.withSlot(async () => {
      if (options.write ?? method !== 'GET') this.takeWriteBudget(method, pathAndQuery.split('?')[0] ?? pathAndQuery)
      return this.send(method, host, pathAndQuery, token, headers, options)
    })
  }

  async withSlot<T>(task: () => Promise<T>): Promise<T> {
    await this.acquireSlot()
    try {
      return await task()
    } finally {
      this.releaseSlot()
    }
  }

  private takeWriteBudget(method: string, path: string) {
    const minuteAgo = this.now() - 60_000
    while (this.writeTimes.length && (this.writeTimes[0] ?? 0) <= minuteAgo) this.writeTimes.shift()
    if (this.writeTimes.length >= MAX_WRITES_PER_MINUTE) {
      throw new ToolError(messages.writeBudget(method, path, MAX_WRITES_PER_MINUTE))
    }
    this.writeTimes.push(this.now())
  }

  private async acquireSlot() {
    if (this.active < MAX_CONCURRENT_REQUESTS) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
  }

  private releaseSlot() {
    const next = this.waiting.shift()
    if (next) next()
    else this.active--
  }

  private async send(
    method: string,
    host: string,
    pathAndQuery: string,
    token: string,
    headers: Record<string, string>,
    options: RequestOptions
  ): Promise<ApiResponse> {
    const path = pathAndQuery.split('?')[0] ?? pathAndQuery
    const write = options.write ?? method !== 'GET'
    const hasBody = options.body !== undefined && options.body !== null
    let response: Response
    try {
      response = await this.fetchFn(`https://${host}${pathAndQuery}`, {
        method,
        headers: {
          ...headers,
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Accept-Language': 'en',
          ...(hasBody ? { 'Content-Type': 'application/json' } : {})
        },
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch {
      throw new ToolError(write ? messages.writeNoResponse(method, path) : messages.failed(method, path, null))
    }
    options.onStatus?.(response.status)
    if (response.status < 200 || response.status >= 300) {
      return {
        status: response.status,
        headers: response.headers,
        body: null,
        errorText: await readErrorText(response)
      }
    }
    const result = await readBody(response, options.maxBytes ?? Number.POSITIVE_INFINITY, method, path)
    if ('body' in result) return { status: response.status, headers: response.headers, body: result.body }
    if (!write) throw result.error
    return {
      status: response.status,
      headers: response.headers,
      body: null,
      bodyNote: messages.writeBodyNotReturned(method, path, response.status, result.reason)
    }
  }
}

async function readBody(response: Response, maxBytes: number, method: string, path: string): Promise<BodyResult> {
  const tooLarge = {
    reason: 'it is larger than 500 KB',
    error: new ResponseTooLargeError(messages.tooLarge(method, path))
  }
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    return tooLarge
  }
  const chunks: Uint8Array[] = []
  if (response.body) {
    const reader = response.body.getReader()
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined)
          return tooLarge
        }
        chunks.push(value)
      }
    } catch {
      return { reason: 'it could not be read', error: new ToolError(messages.failed(method, path, null)) }
    }
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks))
  if (text === '') return { body: null }
  const contentType = response.headers.get('content-type') ?? ''
  const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  if (mediaType === 'application/yaml' || mediaType === 'text/yaml') return { body: text }
  if (mediaType !== 'application/json') {
    const shown = contentType || 'no content type'
    return { reason: `it is ${shown}, not JSON`, error: new ToolError(messages.notJson(method, path, shown)) }
  }
  try {
    return { body: JSON.parse(text) }
  } catch {
    return {
      reason: 'it is not valid JSON',
      error: new ToolError(messages.invalidJson(method, path, response.status))
    }
  }
}

const ERROR_TEXT_MAX_CHARS = 500

async function readErrorText(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const decoder = new TextDecoder()
  let text = ''
  try {
    while (text.length < ERROR_TEXT_MAX_CHARS) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } catch {
    return undefined
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const trimmed = text.trim().slice(0, ERROR_TEXT_MAX_CHARS)
  return trimmed === '' ? undefined : trimmed
}
