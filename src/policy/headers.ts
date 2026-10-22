import { messages, ToolError } from '../errors.js'

const ALLOWED_HEADERS: Record<string, string> = { range: 'Range', 'if-match': 'If-Match' }

export function checkHeaders(headers: Record<string, string>): Record<string, string> {
  const checked: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const allowed = ALLOWED_HEADERS[name.toLowerCase()]
    if (allowed === undefined || /[\r\n]/.test(value)) throw new ToolError(messages.headerNotAllowed(name))
    checked[allowed] = value
  }
  return checked
}
