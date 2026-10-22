import type { RouteRule } from './tables.js'

export interface Route {
  method: string
  service: string
  match: string
  blockMatch: string
}

export function onAllowList(rules: readonly RouteRule[], route: Route): boolean {
  return matches(rules, route, route.match)
}

export function onBlockList(rules: readonly RouteRule[], route: Route): boolean {
  return matches(rules, route, route.blockMatch)
}

function matches(rules: readonly RouteRule[], route: Route, path: string): boolean {
  return rules.some((rule) => rule.method === route.method && rule.service === route.service && rule.pattern.test(path))
}
