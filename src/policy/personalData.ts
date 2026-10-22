import { messages, ToolError } from '../errors.js'
import { onAllowList, type Route } from './routes.js'
import { PERSONAL_DATA_ROUTE_ALLOWLIST, PERSONAL_DATA_SERVICES } from './tables.js'

const BORDERLINE_SERVICES = new Set(PERSONAL_DATA_ROUTE_ALLOWLIST.map((rule) => rule.service))

export function checkPersonalData(route: Route, target: string, allowPersonalData: boolean) {
  if (allowPersonalData) return
  if (PERSONAL_DATA_SERVICES.includes(route.service)) {
    throw new ToolError(messages.personalDataService(route.service))
  }
  if (BORDERLINE_SERVICES.has(route.service) && !onAllowList(PERSONAL_DATA_ROUTE_ALLOWLIST, route)) {
    throw new ToolError(messages.personalDataRoute(route.method, target))
  }
}
