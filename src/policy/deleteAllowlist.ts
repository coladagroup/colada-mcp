import { messages, ToolError } from '../errors.js'
import { onAllowList, type Route } from './routes.js'
import { DELETE_ALLOWLIST } from './tables.js'

export function checkDeleteAllowlist(route: Route, target: string) {
  if (route.method === 'DELETE' && !onAllowList(DELETE_ALLOWLIST, route)) {
    throw new ToolError(messages.deleteNotAllowed(target))
  }
}
