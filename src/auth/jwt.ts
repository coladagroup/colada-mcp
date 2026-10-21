export type Claims = Record<string, unknown>

export function decodeClaims(token: string): Claims {
  const payload = token.split('.')[1]
  if (!payload) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? (parsed as Claims) : {}
  } catch {
    return {}
  }
}

export function userOf(claims: Claims): string | null {
  for (const name of ['preferred_username', 'email']) {
    const value = claims[name]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

export function expiresAt(claims: Claims): number {
  return typeof claims.exp === 'number' ? claims.exp : 0
}
