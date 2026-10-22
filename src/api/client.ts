import { messages, ToolError } from '../errors.js'

export interface ApiResponse {
  status: number
  headers: Headers
  body: unknown
}

export interface RequestOptions {
  body?: unknown
  maxBytes?: number
}

export class ApiClient {
  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly timeoutMs = 30_000
  ) {}

  get(host: string, pathAndQuery: string, token: string, headers: Record<string, string> = {}) {
    return this.request('GET', host, pathAndQuery, token, headers)
  }

  async request(
    method: string,
    host: string,
    pathAndQuery: string,
    token: string,
    headers: Record<string, string> = {},
    options: RequestOptions = {}
  ): Promise<ApiResponse> {
    const path = pathAndQuery.split('?')[0] ?? pathAndQuery
    const hasBody = options.body !== undefined
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
      throw new ToolError(messages.failed(method, path, null))
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined)
      return { status: response.status, headers: response.headers, body: null }
    }
    const text = await readText(response, options.maxBytes ?? Number.POSITIVE_INFINITY, method, path)
    return { status: response.status, headers: response.headers, body: parseBody(response, text, method, path) }
  }
}

async function readText(response: Response, maxBytes: number, method: string, path: string): Promise<string> {
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new ToolError(messages.tooLarge(method, path))
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new ToolError(messages.tooLarge(method, path))
      }
      chunks.push(value)
    }
  } catch (err) {
    if (err instanceof ToolError) throw err
    throw new ToolError(messages.failed(method, path, null))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseBody(response: Response, text: string, method: string, path: string): unknown {
  if (text === '') return null
  const contentType = response.headers.get('content-type') ?? ''
  const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  if (mediaType === 'application/yaml' || mediaType === 'text/yaml') return text
  if (mediaType !== 'application/json') {
    throw new ToolError(messages.notJson(method, path, contentType || 'no content type'))
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new ToolError(messages.invalidJson(method, path, response.status))
  }
}
