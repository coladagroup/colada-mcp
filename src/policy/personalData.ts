import { messages, ToolError } from '../errors.js'
import { onAllowList, type Route } from './routes.js'
import { PERSONAL_DATA_ROUTE_ALLOWLIST, PERSONAL_DATA_SERVICES } from './tables.js'

export function checkPersonalData(route: Route, target: string, allowPersonalData: boolean) {
  if (allowPersonalData) return
  if (PERSONAL_DATA_SERVICES.includes(route.service) && !onAllowList(PERSONAL_DATA_ROUTE_ALLOWLIST, route)) {
    throw new ToolError(messages.personalData(route.method, target))
  }
}
