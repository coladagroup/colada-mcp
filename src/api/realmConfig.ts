import { messages, ToolError } from '../errors.js'

const REALM_NAME = /^[A-Za-z0-9_-]+$/

export async function fetchRealm(fetchFn: typeof fetch, host: string): Promise<string> {
  let response: Response
  try {
    response = await fetchFn(`https://${host}/_gw/s-ecosystem/oauthclients/colada-mcp/config`, { redirect: 'error' })
  } catch {
    throw new ToolError(messages.realmUnknown(host, null))
  }
  const body: unknown = await response.json().catch(() => null)
  const realm = (body as { realm?: unknown } | null)?.realm
  if (!response.ok || typeof realm !== 'string' || !REALM_NAME.test(realm)) {
    throw new ToolError(messages.realmUnknown(host, response.status))
  }
  return realm
}
