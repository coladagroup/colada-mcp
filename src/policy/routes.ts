import type { RouteRule } from './tables.js'

export interface Route {
  method: string
  service: string
  match: string
}

export function onList(rules: readonly RouteRule[], route: Route): boolean {
  return rules.some(
    (rule) => rule.method === route.method && rule.service === route.service && rule.pattern.test(route.match)
  )
}
