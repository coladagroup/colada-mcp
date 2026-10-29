import { checkDeleteAllowlist } from './deleteAllowlist.js'
import { checkDeleteDenylist } from './deleteDenylist.js'
import { checkHeaders } from './headers.js'
import type { MarkerIndex } from './markers.js'
import { checkWriteMethod } from './method.js'
import { checkPath } from './path.js'
import { checkPersonalData } from './personalData.js'
import { checkSecrets } from './secrets.js'
import { checkService } from './service.js'
import type { Method } from './tables.js'

export { checkService } from './service.js'
export { MAX_RESPONSE_BYTES } from './size.js'

const PROJECTION_SUFFIX = /:\([^/]*\)\/?$/

export interface PolicyInput {
  service: string
  path: string
  headers?: Record<string, string>
}

export interface CheckedRequest {
  method: Method
  headers: Record<string, string>
}

export function checkRead(input: PolicyInput, allowPersonalData: boolean, markers?: MarkerIndex): CheckedRequest {
  return check(() => 'GET', input, allowPersonalData, markers)
}

export function checkWrite(
  method: string,
  input: PolicyInput,
  allowPersonalData: boolean,
  markers?: MarkerIndex
): CheckedRequest {
  return check(() => checkWriteMethod(method), input, allowPersonalData, markers)
}

function blockForm(path: string): string {
  return path.toLowerCase().replace(PROJECTION_SUFFIX, '')
}

function check(
  resolveMethod: () => Method,
  input: PolicyInput,
  allowPersonalData: boolean,
  markers: MarkerIndex | undefined
): CheckedRequest {
  checkService(input.service)
  const match = checkPath(input.path)
  const route = { method: resolveMethod(), service: input.service, match, blockMatch: blockForm(match) }
  const target = `/_gw/${input.service}${input.path}`
  checkDeleteAllowlist(route, target)
  checkDeleteDenylist(route, target)
  checkSecrets(route, target)
  checkPersonalData(route, target, allowPersonalData, markers)
  return { method: route.method, headers: checkHeaders(input.headers ?? {}) }
}
