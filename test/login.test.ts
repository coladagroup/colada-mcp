import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createPkce } from '../src/auth/login.js'

describe('PKCE', () => {
  it('creates a 32-byte verifier, its S256 challenge and a random state', () => {
    const pkce = createPkce()
    expect(Buffer.from(pkce.verifier, 'base64url')).toHaveLength(32)
    expect(pkce.verifier).not.toMatch(/[=+/]/)
    expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'))
    expect(Buffer.from(pkce.state, 'base64url')).toHaveLength(32)
    expect(createPkce().state).not.toBe(pkce.state)
  })
})
