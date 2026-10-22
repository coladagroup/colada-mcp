import { messages, ToolError } from '../errors.js'
import type { Method } from './tables.js'

const WRITE_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE']

export function checkWriteMethod(method: string): Method {
  const upper = method.toUpperCase()
  if (!WRITE_METHODS.includes(upper)) throw new ToolError(messages.methodNotAllowed(method))
  return upper as Method
}
