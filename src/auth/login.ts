import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CLIENT_ID, openIdUrl, postToken, type TokenResult } from './tokenEndpoint.js'

const LOGIN_TIMEOUT_MS = 30 * 60 * 1000

export interface LoginDeps {
  fetch: typeof fetch
  openBrowser: (url: string) => Promise<boolean>
  log: (message: string) => void
  loginTimeoutMs?: number
}

export interface PendingLogin {
  url: string
  opened: boolean
  close: () => void
}

export function createPkce() {
  const verifier = randomBytes(32).toString('base64url')
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: randomBytes(32).toString('base64url')
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function page(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><body><p>${text}</p></body></html>`)
}

export async function startLogin(
  host: string,
  realm: string,
  deps: LoginDeps,
  onTokens: (tokens: TokenResult) => Promise<void>,
  onClosed: () => void
): Promise<PendingLogin> {
  const pkce = createPkce()
  let handled = false
  let redirectUri = ''

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (handled || req.method !== 'GET' || url.pathname !== '/' || url.searchParams.get('state') !== pkce.state) {
      res.writeHead(404).end()
      return
    }
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')
    if (error !== null) {
      handled = true
      res.once('finish', close)
      page(res, 200, `Login failed: ${escapeHtml(error)}. Call the tool again to retry.`)
      return
    }
    if (code === null) {
      res.writeHead(404).end()
      return
    }
    handled = true
    res.once('finish', close)
    exchange(code).then((ok) =>
      page(res, 200, ok ? 'Login done. You can close this tab.' : 'Login failed. Call the tool again.')
    )
  })

  async function exchange(code: string): Promise<boolean> {
    try {
      const result = await postToken(deps.fetch, host, realm, {
        grant_type: 'authorization_code',
        code,
        code_verifier: pkce.verifier,
        redirect_uri: redirectUri
      })
      if (result.status !== 200 || !result.accessToken || !result.refreshToken) {
        deps.log(`colada-mcp: login code exchange for realm ${realm} failed (HTTP ${result.status})`)
        return false
      }
      await onTokens(result)
      return true
    } catch (err) {
      deps.log(`colada-mcp: login code exchange for realm ${realm} failed (${(err as Error).message})`)
      return false
    }
  }

  let closed = false
  const timer = setTimeout(() => close(), deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS)
  timer.unref()

  function close() {
    if (closed) return
    closed = true
    clearTimeout(timer)
    server.close()
    server.closeIdleConnections()
    onClosed()
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  server.unref()
  const { port } = server.address() as AddressInfo
  redirectUri = `http://127.0.0.1:${port}`

  const authUrl = new URL(openIdUrl(host, realm, 'auth'))
  authUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid',
    state: pkce.state,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256'
  }).toString()
  const url = authUrl.toString()

  let opened = false
  try {
    opened = await deps.openBrowser(url)
  } catch {
    opened = false
  }
  return { url, opened, close }
}
