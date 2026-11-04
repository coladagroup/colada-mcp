import { messages, ToolError } from '../errors.js'
import { type MarkerIndex, markerFor } from './markers.js'
import { onAllowList, type Route } from './routes.js'
import { PERSONAL_DATA_ROUTE_ALLOWLIST, PERSONAL_DATA_SERVICES } from './tables.js'

export function checkPersonalData(route: Route, target: string, allowPersonalData: boolean, markers?: MarkerIndex) {
  if (allowPersonalData) return
  const marker = markers === undefined ? undefined : markerFor(markers, route.method, route.match)
  if (marker === false) return
  if (
    marker === true ||
    (PERSONAL_DATA_SERVICES.includes(route.service) && !onAllowList(PERSONAL_DATA_ROUTE_ALLOWLIST, route))
  ) {
    throw new ToolError(messages.personalData(route.method, target))
  }
}
