import { messages, ToolError } from '../errors.js'

const PATH_CHARACTERS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*$/
const ENCODED_SEPARATOR = /%2f|%2e|%5c/i

export function checkPath(path: string): string {
  const refuse = (reason: string) => new ToolError(messages.pathNotAllowed(path, reason))
  if (!path.startsWith('/api/')) throw refuse('it must start with /api/')
  if (path.includes('?') || path.includes('#')) throw refuse('it must not contain "?" or "#"')
  if (!PATH_CHARACTERS.test(path)) {
    throw refuse(`it must only contain letters, digits, "-._~!$&'()*+,;=:@/" and %-escapes`)
  }
  if (ENCODED_SEPARATOR.test(path)) throw refuse('it must not contain an encoded "/", "." or "\\" (%2F, %2E, %5C)')
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    throw refuse('it has an invalid %-encoding')
  }
  if (hasSpaceOrControl(decoded)) throw refuse('it must not contain an encoded space or control character')
  if (decoded.includes('..') || decoded.includes('//')) throw refuse('it must not contain ".." or "//"')
  if (decoded.split('/').includes('.')) throw refuse('it must not contain a "." segment')
  if (new URL(path, 'https://h.example.com').pathname !== path) throw refuse('it changes when the URL is parsed')
  return decoded
}

function hasSpaceOrControl(value: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Z}]/u.test(value)
}
