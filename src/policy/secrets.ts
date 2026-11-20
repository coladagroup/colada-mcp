import { fail } from '../errors.js'
import { onBlockList, type Route } from './routes.js'
import { SECRET_ROUTES } from './tables.js'

export function checkSecrets(route: Route, target: string) {
  if (onBlockList(SECRET_ROUTES, route)) throw fail.secretRoute(route.method, target)
}
