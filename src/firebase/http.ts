import type { ApiClient } from '../api/client.js'
import { messages, ToolError } from '../errors.js'

export const MAX_FIREBASE_DOWNLOAD_BYTES = 10_000_000
const ERROR_TEXT_MAX_CHARS = 500

export interface FirebaseRequest {
  url: string
  method?: 'GET' | 'POST'
  bearer?: string
  body?: unknown
  store: string
  path: string
  tooLarge: () => string
}

export interface FirebaseResponse {
  status: number
  body: unknown
  errorText?: string
}

export class FirebaseHttp {
  constructor(
    private readonly api: ApiClient,
    private readonly fetchFn: typeof fetch,
    private readonly timeoutMs = 30_000
  ) {}

  request(request: FirebaseRequest): Promise<FirebaseResponse> {
    return this.api.withSlot(() => this.send(request))
  }

  private async send(request: FirebaseRequest): Promise<FirebaseResponse> {
    const hasBody = request.body !== undefined
    let response: Response
    try {
      response = await this.fetchFn(request.url, {
        method: request.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...(request.bearer ? { Authorization: `Bearer ${request.bearer}` } : {}),
          ...(hasBody ? { 'Content-Type': 'application/json' } : {})
        },
        ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch {
      throw new ToolError(messages.firebaseFailed(request.store, request.path, null))
    }
    if (response.status < 200 || response.status >= 300) {
      const errorText = (await readBytes(response, ERROR_TEXT_MAX_CHARS)).toString('utf8')
      return {
        status: response.status,
        body: parseOrNull(errorText),
        errorText: errorText.trim().slice(0, ERROR_TEXT_MAX_CHARS)
      }
    }
    if (Number(response.headers.get('content-length') ?? 0) > MAX_FIREBASE_DOWNLOAD_BYTES) {
      await response.body?.cancel().catch(() => undefined)
      throw new ToolError(request.tooLarge())
    }
    const bytes = await readBytes(response, MAX_FIREBASE_DOWNLOAD_BYTES + 1)
    if (bytes.byteLength > MAX_FIREBASE_DOWNLOAD_BYTES) throw new ToolError(request.tooLarge())
    const text = bytes.toString('utf8')
    try {
      return { status: response.status, body: text === '' ? null : JSON.parse(text) }
    } catch {
      throw new ToolError(messages.firebaseFailed(request.store, request.path, response.status))
    }
  }
}

async function readBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      chunks.push(value)
    }
  } catch {
    return Buffer.alloc(0)
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks)
}

function parseOrNull(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
