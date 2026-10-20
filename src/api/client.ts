import { messages, ToolError } from '../errors.js'

export interface ApiResponse {
  status: number
  headers: Headers
  body: unknown
}

export class ApiClient {
  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly timeoutMs = 30_000
  ) {}

  async get(host: string, pathAndQuery: string, token: string, headers: Record<string, string> = {}) {
    const path = pathAndQuery.split('?')[0] ?? pathAndQuery
    let response: Response
    try {
      response = await this.fetchFn(`https://${host}${pathAndQuery}`, {
        method: 'GET',
        headers: {
          ...headers,
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Accept-Language': 'en'
        },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch {
      throw new ToolError(messages.failed(path, null))
    }
    const ok = response.status >= 200 && response.status < 300
    let text: string
    try {
      text = await response.text()
    } catch {
      if (ok) throw new ToolError(messages.failed(path, null))
      text = ''
    }
    let body: unknown = null
    try {
      body = text === '' ? null : JSON.parse(text)
    } catch {
      body = null
    }
    if (ok && body === null) throw new ToolError(messages.failed(path, response.status))
    return { status: response.status, headers: response.headers, body } satisfies ApiResponse
  }
}
