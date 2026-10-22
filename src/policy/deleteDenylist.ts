import { messages, ToolError } from '../errors.js'
import { onBlockList, type Route } from './routes.js'
import { DELETE_DENYLIST } from './tables.js'

export function checkDeleteDenylist(route: Route, target: string) {
  if (onBlockList(DELETE_DENYLIST, route)) throw new ToolError(messages.deleteRoute(route.method, target))
}
