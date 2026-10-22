import { checkDeleteAllowlist } from './deleteAllowlist.js'
import { checkDeleteDenylist } from './deleteDenylist.js'
import { checkHeaders } from './headers.js'
import { checkWriteMethod } from './method.js'
import { checkPath } from './path.js'
import { checkPersonalData } from './personalData.js'
import { checkSecrets } from './secrets.js'
import { checkService } from './service.js'
import type { Method } from './tables.js'

export { checkService } from './service.js'
export { MAX_RESPONSE_BYTES } from './size.js'

export interface PolicyInput {
  service: string
  path: string
  headers?: Record<string, string>
}

export interface CheckedRequest {
  method: Method
  headers: Record<string, string>
}

export function checkRead(input: PolicyInput, allowPersonalData: boolean): CheckedRequest {
  return check(() => 'GET', input, allowPersonalData)
}

export function checkWrite(method: string, input: PolicyInput, allowPersonalData: boolean): CheckedRequest {
  return check(() => checkWriteMethod(method), input, allowPersonalData)
}

function check(resolveMethod: () => Method, input: PolicyInput, allowPersonalData: boolean): CheckedRequest {
  checkService(input.service)
  const match = checkPath(input.path)
  const route = { method: resolveMethod(), service: input.service, match }
  const target = `/_gw/${input.service}${input.path}`
  checkDeleteAllowlist(route, target)
  checkDeleteDenylist(route, target)
  checkSecrets(route, target)
  checkPersonalData(route, target, allowPersonalData)
  return { method: route.method, headers: checkHeaders(input.headers ?? {}) }
}
