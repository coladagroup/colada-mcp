import { messages, ToolError } from '../errors.js'

const ALLOWED_HEADERS: Record<string, string> = { range: 'Range', 'if-match': 'If-Match' }

const HEADER_VALUE = /^[\x20-\x7e]*$/

export function checkHeaders(headers: Record<string, string>): Record<string, string> {
  const checked: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase()
    const allowed = Object.hasOwn(ALLOWED_HEADERS, key) ? ALLOWED_HEADERS[key] : undefined
    if (allowed === undefined || !HEADER_VALUE.test(value)) throw new ToolError(messages.headerNotAllowed(name))
    checked[allowed] = value
  }
  return checked
}
