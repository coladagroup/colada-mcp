import { messages, ToolError } from '../errors.js'

const ENCODED_SEPARATOR = /%2f|%2e|%5c/i

export function checkPath(path: string): string {
  const refuse = (reason: string) => new ToolError(messages.pathNotAllowed(path, reason))
  if (!path.startsWith('/api/')) throw refuse('it must start with /api/')
  if (path.includes('?') || path.includes('#')) throw refuse('it must not contain "?" or "#"')
  if (ENCODED_SEPARATOR.test(path)) throw refuse('it must not contain an encoded "/", "." or "\\" (%2F, %2E, %5C)')
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    throw refuse('it has an invalid %-encoding')
  }
  if (decoded.includes('..') || decoded.includes('//')) throw refuse('it must not contain ".." or "//"')
  return decoded.toLowerCase()
}
