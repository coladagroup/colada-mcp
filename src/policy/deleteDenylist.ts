import { messages, ToolError } from '../errors.js'
import { onList, type Route } from './routes.js'
import { DELETE_DENYLIST } from './tables.js'

export function checkDeleteDenylist(route: Route, target: string) {
  if (onList(DELETE_DENYLIST, route)) throw new ToolError(messages.deleteRoute(route.method, target))
}
