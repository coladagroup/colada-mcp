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
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch {
      throw new ToolError(messages.failed(path, null))
    }
    const text = await response.text().catch(() => '')
    let body: unknown = null
    if (text !== '') {
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
    }
    return { status: response.status, headers: response.headers, body } satisfies ApiResponse
  }
}
