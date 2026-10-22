import { messages, ToolError } from '../errors.js'
import { onList, type Route } from './routes.js'
import { SECRET_ROUTES } from './tables.js'

export function checkSecrets(route: Route, target: string) {
  if (onList(SECRET_ROUTES, route)) throw new ToolError(messages.secretRoute(route.method, target))
}
