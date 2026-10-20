export const CLIENT_ID = 'colada-mcp'

export interface TokenResult {
  status: number
  accessToken?: string
  refreshToken?: string
  error?: string
}

export function openIdUrl(host: string, realm: string, endpoint: 'auth' | 'token'): string {
  return `https://${host}/auth/realms/${realm}/protocol/openid-connect/${endpoint}`
}

export async function postToken(
  fetchFn: typeof fetch,
  host: string,
  realm: string,
  params: Record<string, string>
): Promise<TokenResult> {
  const response = await fetchFn(openIdUrl(host, realm, 'token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }).toString(),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000)
  })
  let json: Record<string, unknown> = {}
  try {
    json = (await response.json()) as Record<string, unknown>
  } catch {
    json = {}
  }
  return {
    status: response.status,
    accessToken: typeof json.access_token === 'string' ? json.access_token : undefined,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    error: typeof json.error === 'string' ? json.error : undefined
  }
}
