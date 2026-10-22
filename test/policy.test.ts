import { describe, expect, it } from 'vitest'
import { parseAllowPersonalData } from '../src/config.js'
import { checkRead, checkService, checkWrite } from '../src/policy/index.js'
import {
  DELETE_ALLOWLIST,
  DELETE_DENYLIST,
  PERSONAL_DATA_ROUTE_ALLOWLIST,
  PERSONAL_DATA_SERVICES,
  SECRET_ROUTES
} from '../src/policy/tables.js'

type Case = [id: string, service: string, method: string, path: string]

function check(method: string, service: string, path: string, allowPersonalData = false, headers = {}) {
  const input = { service, path, headers }
  return method === 'GET' ? checkRead(input, allowPersonalData) : checkWrite(method, input, allowPersonalData)
}

function refusal(method: string, service: string, path: string, allowPersonalData = false, headers = {}) {
  try {
    check(method, service, path, allowPersonalData, headers)
  } catch (err) {
    return (err as Error).message
  }
  return null
}

const deleteRoute = (method: string, service: string, path: string) =>
  `${method} /_gw/${service}${path} is blocked: this route deletes data (MCP delete denylist). Delete data in the backoffice.`
const secretRoute = (method: string, service: string, path: string) =>
  `${method} /_gw/${service}${path} is blocked: this route reads or changes secrets (SMTP, Stripe, tokens, passwords, OTP). It is always blocked.`
const personalDataService = (service: string) =>
  `${service} holds personal data and is off. To turn it on, set COLADA_ALLOW_PERSONAL_DATA=true in the MCP config and restart the client.`
const personalDataRoute = (method: string, service: string, path: string) =>
  `${method} /_gw/${service}${path} may return personal data and is off. To turn it on, set COLADA_ALLOW_PERSONAL_DATA=true in the MCP config and restart the client.`
const pathRefused = (path: string, reason: string) =>
  `Path "${path}" is not allowed: ${reason}. Put query parameters in "query".`

const DENYLIST_CASES: Case[] = [
  ['D01', 's-events-guests', 'PATCH', '/api/events/e1/guests'],
  ['D02', 's-directory-locations', 'PATCH', '/api/locations'],
  ['D03', 's-directory-accounts', 'PATCH', '/api/accounts'],
  ['D04', 's-directory-contacts', 'PATCH', '/api/contacts'],
  ['D05', 's-campaigns', 'PATCH', '/api/campaigns'],
  ['D06', 's-email-templates', 'PATCH', '/api/emailtemplates'],
  ['D07', 's-email-templates', 'PATCH', '/api/events/e1/emailtemplates'],
  ['D08', 's-events-guests', 'POST', '/api/events/e1/guests/delete/jobs'],
  ['D09', 's-directory-contacts', 'POST', '/api/contacts/delete/jobs'],
  ['D10', 's-workspaces', 'POST', '/api/admin/workspaces/jobs/removal'],
  ['D11', 's-events-invoices', 'POST', '/api/events/e1/guestsinvoices/remove/jobs'],
  ['D12', 's-campaigns', 'GET', '/api/campaigns/c1/image/delete'],
  ['D13', 's-events-mcontent-requests', 'GET', '/api/events/e1/mcontent/requests/r1/file/delete/url'],
  ['D14', 's-events-invoices', 'POST', '/api/events/e1/brokersinvoices/remove/jobs']
]

const SECRET_CASES: Case[] = [
  ['S01', 's-workspaces', 'GET', '/api/workspaces/w1/smtp'],
  ['S02', 's-workspaces', 'PUT', '/api/workspaces/w1/smtp'],
  ['S03', 's-licenses', 'GET', '/api/stripe/billing-portal'],
  ['S04', 's-campaigns-integration', 'GET', '/api/stripe/settings'],
  ['S05', 's-campaigns-integration', 'PUT', '/api/stripe/settings'],
  ['S06', 's-campaigns-integration', 'POST', '/api/stripe/payment-links'],
  ['S07', 's-access', 'POST', '/api/auth/integrations/campaigns/firebase/token'],
  ['S11', 's-access', 'PUT', '/api/users/u1/reset-otp'],
  ['S12', 's-directory-contacts', 'PUT', '/api/contacts/c1/password/reset'],
  ['S13', 's-workspaces', 'GET', '/api/workspaces/w1/smtp-with-creds'],
  ['S14', 's-workspaces', 'PUT', '/api/admin/workspaces/w1/stripe'],
  ['S15', 's-licenses', 'PUT', '/api/stripe/checkout/s1/expired']
]

const ALLOW_CASES: Case[] = [
  ['A01', 's-documents', 'GET', '/api/events/e1/documents/templates'],
  ['A02', 's-documents', 'GET', '/api/events/e1/documents/templates/t1'],
  ['A03', 's-documents', 'POST', '/api/events/e1/documents/badge/templates'],
  ['A04', 's-documents', 'PUT', '/api/events/e1/documents/templates/t1'],
  ['A05', 's-documents', 'PUT', '/api/events/e1/documents/templates/t1/copied'],
  ['A06', 's-documents', 'GET', '/api/events/e1/documents/templates/settings'],
  ['A07', 's-documents', 'PUT', '/api/events/e1/documents/templates/settings'],
  ['A08', 's-documents', 'PUT', '/api/documenttemplates/fonts/files'],
  ['A09', 's-documents', 'GET', '/api/documenttemplates/fonts/files/f1'],
  ['A10', 's-documents', 'PUT', '/api/documenttemplates/files'],
  ['A11', 's-documents', 'GET', '/api/documenttemplates/files/f1'],
  ['A12', 's-file-storage', 'PUT', '/api/public-files/events/e1/pages/p1/upload/url'],
  ['A13', 's-file-storage', 'PUT', '/api/files/events/e1/emailtemplates/t1/attachments/upload/url'],
  ['A14', 's-file-storage', 'GET', '/api/files/assets/a1/download/url'],
  ['A15', 's-directory-accounts', 'GET', '/api/accounts/count'],
  ['A16', 's-directory-accounts', 'GET', '/api/accounts/projections'],
  ['A17', 's-workspaces', 'GET', '/api/workspaces'],
  ['A18', 's-workspaces', 'GET', '/api/workspaces/w1'],
  ['A19', 's-workspaces', 'GET', '/api/workspaces/w1/vat-rates'],
  ['A20', 's-workspaces', 'PUT', '/api/workspaces/w1/languages'],
  ['A21', 's-workspaces', 'GET', '/api/workspaces/w1/featuretoggles/my'],
  ['A22', 's-workspaces', 'GET', '/api/constants'],
  ['A23', 's-workspaces', 'PUT', '/api/constants'],
  ['A24', 's-workspaces', 'GET', '/api/admin/workspaces/featuretoggles'],
  ['A25', 's-workspaces', 'GET', '/api/admin/workspaces/w1/featuretoggles'],
  ['A26', 's-workspaces', 'GET', '/api/admin/workspaces/jobs/j1/status'],
  ['A27', 's-workspaces', 'PUT', '/api/admin/workspaces/w1/featuretoggles'],
  ['A28', 's-licenses', 'GET', '/api/licenses/l1'],
  ['A29', 's-licenses', 'GET', '/api/licenses/items/cost'],
  ['A30', 's-licenses', 'GET', '/api/licenses/features/my'],
  ['A31', 's-licenses', 'GET', '/api/applications'],
  ['A32', 's-licenses', 'GET', '/api/admin/workspaces/w1/licenses/l1'],
  ['A33', 's-licenses', 'POST', '/api/licensesinvoices/purchase/cost'],
  ['A34', 's-licenses', 'GET', '/api/licensesinvoices/generate/jobs/j1/status'],
  ['A35', 's-licenses', 'GET', '/api/subscriptions'],
  ['A36', 's-licenses', 'GET', '/api/admin/workspaces/w1/subscriptions'],
  ['A37', 's-licenses', 'POST', '/api/subscriptions/trial-end-date'],
  ['A38', 's-licenses', 'GET', '/api/transactions'],
  ['A39', 's-licenses', 'GET', '/api/admin/reporting/jobs/j1/status'],
  ['A40', 's-licenses', 'PUT', '/api/admin/workspaces/w1/licenses/l1'],
  ['A41', 's-licenses', 'POST', '/api/admin/applications/predefined/copy'],
  ['A42', 's-licenses', 'POST', '/api/admin/licenses/predefined/copy'],
  ['A43', 's-orgstructure', 'PUT', '/api/orgstructure/departments/d1/children/d2'],
  ['A44', 's-orgstructure', 'GET', '/api/orgstructure/users/me/departments'],
  ['A45', 's-orgstructure', 'GET', '/api/orgstructure/events/e1/departments'],
  ['A46', 's-orgstructure', 'PUT', '/api/orgstructure/campaigns/c1/events/e1/departments'],
  ['A47', 's-orgstructure', 'GET', '/api/orgstructure/users/u1/departments'],
  ['A48', 's-consumer-portal-admin', 'GET', '/api/consumerportal/pages/p1/children'],
  ['A49', 's-consumer-portal-admin', 'POST', '/api/consumerportal/pages'],
  ['A50', 's-consumer-portal-admin', 'PUT', '/api/consumerportal/pages/p1/rank'],
  ['A51', 's-consumer-portal-admin', 'POST', '/api/consumerportal/pages/p1/files/logo.png'],
  ['A52', 's-consumer-portal-admin', 'PUT', '/api/consumerportal/pages/p1/published'],
  ['A53', 's-events-resources-inventory', 'GET', '/api/events/e1/resources/rn_room/slotschema'],
  ['A54', 's-events-resources-inventory', 'POST', '/api/events/e1/resources/rn_room/slots/indexing/jobs'],
  ['A55', 's-events-resources-inventory', 'GET', '/api/events/e1/resources/rn_room/slots/indexing/jobs/j1/status']
]

const BORDERLINE_NEIGHBOURS: Array<[service: string, method: string, path: string]> = [
  ['s-documents', 'GET', '/api/events/e1/guestsdocuments'],
  ['s-file-storage', 'PUT', '/api/files/copy/bulk'],
  ['s-directory-accounts', 'GET', '/api/accounts'],
  ['s-workspaces', 'GET', '/api/workspaces/w1/info'],
  ['s-licenses', 'GET', '/api/licenses/items'],
  ['s-orgstructure', 'PUT', '/api/orgstructure/users/u1/departments'],
  ['s-consumer-portal-admin', 'GET', '/api/consumerportal/personalgallery/consumers/c1/items'],
  ['s-events-resources-inventory', 'GET', '/api/events/e1/resources/slots']
]

const FULL_BLOCK_SERVICES = [
  's-events-guests',
  's-events-guests-bookings',
  's-events-guests-changelog',
  's-events-guests-importpln',
  's-events-guests-exportpln',
  's-directory-contacts',
  's-directory-contacts-importpln',
  's-directory-contacts-exportpln',
  's-contacts-time-slots',
  's-access',
  's-speakers',
  's-speakers-contracts',
  's-speakers-engagements',
  's-speakers-requests',
  's-speakers-scoring-profiles',
  's-speakers-requests-newscaster',
  's-events-invoices',
  's-events-payments',
  's-guest-nominations',
  's-assistant-scanner',
  's-printers',
  's-emailcomposer',
  's-email-logger',
  's-notifications',
  's-newscaster',
  's-newscaster-scheduler',
  's-events-mcontent-requests',
  's-events-brokers',
  's-events-registration',
  's-guests-checker'
]

describe('test cases cover the CONTRACT §4 tables', () => {
  it('one case per table row, same ids, services and methods', () => {
    const rows = (rules: typeof DELETE_DENYLIST) => rules.map((rule) => [rule.id, rule.service, rule.method])
    expect(DENYLIST_CASES.map(([id, service, method]) => [id, service, method])).toEqual(rows(DELETE_DENYLIST))
    expect(SECRET_CASES.map(([id, service, method]) => [id, service, method])).toEqual(rows(SECRET_ROUTES))
    expect(ALLOW_CASES.map(([id, service, method]) => [id, service, method])).toEqual(
      rows(PERSONAL_DATA_ROUTE_ALLOWLIST)
    )
    expect(FULL_BLOCK_SERVICES).toEqual(PERSONAL_DATA_SERVICES)
    expect(DELETE_ALLOWLIST).toEqual([])
  })

  it('every borderline service has a denied neighbour', () => {
    const borderline = [...new Set(PERSONAL_DATA_ROUTE_ALLOWLIST.map((rule) => rule.service))].sort()
    expect([...new Set(BORDERLINE_NEIGHBOURS.map(([service]) => service))].sort()).toEqual(borderline)
  })

  it('every pattern is anchored and lower case', () => {
    const all = [...DELETE_DENYLIST, ...SECRET_ROUTES, ...PERSONAL_DATA_ROUTE_ALLOWLIST]
    for (const rule of all) {
      expect(rule.pattern.source.startsWith('^') && rule.pattern.source.endsWith('$')).toBe(true)
      expect(rule.pattern.source).toBe(rule.pattern.source.toLowerCase())
      expect(rule.pattern.flags).toBe('')
    }
  })
})

describe('check 5: delete denylist (AC22)', () => {
  it.each(DENYLIST_CASES)('%s %s %s %s is blocked', (_id, service, method, path) => {
    expect(refusal(method, service, path)).toBe(deleteRoute(method, service, path))
    expect(refusal(method, service, path, true)).toBe(deleteRoute(method, service, path))
  })

  it.each(DENYLIST_CASES)('%s with a trailing "/" and upper case is blocked too', (_id, service, method, path) => {
    const variant = `${path.toUpperCase().replace('/API/', '/api/')}/`
    expect(refusal(method, service, variant, true)).toBe(deleteRoute(method, service, variant))
  })

  it.each([
    ['s-events-guests', 'PATCH', '/api/events/e1/guests/g1'],
    ['s-directory-contacts', 'PATCH', '/api/contacts/c1'],
    ['s-workspaces', 'PATCH', '/api/constants'],
    ['s-entityschema-manager', 'PATCH', '/api/entityschemas/constant'],
    ['s-events-guests', 'GET', '/api/events/e1/guests/delete/jobs/j1/status']
  ])('neighbour %s %s %s stays open', (service, method, path) => {
    expect(refusal(method, service, path, true)).toBeNull()
  })

  it('an encoded letter is decoded before the check', () => {
    const path = '/api/events/e1/guests/%64elete/jobs'
    expect(refusal('POST', 's-events-guests', path, true)).toBe(deleteRoute('POST', 's-events-guests', path))
  })
})

describe('check 6: secret routes (D51)', () => {
  it.each(SECRET_CASES)('%s %s %s %s is blocked, also with the switch on', (_id, service, method, path) => {
    expect(refusal(method, service, path)).toBe(secretRoute(method, service, path))
    expect(refusal(method, service, path, true)).toBe(secretRoute(method, service, path))
    expect(refusal(method, service, `${path}/`, true)).toBe(secretRoute(method, service, `${path}/`))
  })
})

describe('check 7: personal data (AC25)', () => {
  it.each(ALLOW_CASES)('%s %s %s %s is open with the switch off', (_id, service, method, path) => {
    expect(refusal(method, service, path)).toBeNull()
  })

  it.each(BORDERLINE_NEIGHBOURS)('neighbour %s %s %s is blocked with the switch off', (service, method, path) => {
    expect(refusal(method, service, path)).toBe(personalDataRoute(method, service, path))
    expect(refusal(method, service, path, true)).toBeNull()
  })

  it('a trailing "/" on an allow-listed route falls back to blocked', () => {
    expect(refusal('GET', 's-workspaces', '/api/workspaces/w1/')).toBe(
      personalDataRoute('GET', 's-workspaces', '/api/workspaces/w1/')
    )
  })

  it('an allow-listed path with another method is blocked', () => {
    expect(refusal('POST', 's-workspaces', '/api/constants')).toBe(
      personalDataRoute('POST', 's-workspaces', '/api/constants')
    )
  })

  it.each(FULL_BLOCK_SERVICES)('%s is blocked as a whole with the switch off, open with it on', (service) => {
    expect(refusal('GET', service, '/api/anything')).toBe(personalDataService(service))
    expect(refusal('GET', service, '/api/anything', true)).toBeNull()
  })

  it('other services are open', () => {
    expect(refusal('GET', 's-events', '/api/events/e1')).toBeNull()
    expect(refusal('GET', 's-selections', '/api/selections')).toBeNull()
  })

  it('only the exact value "true" turns the switch on', () => {
    expect(parseAllowPersonalData({ COLADA_ALLOW_PERSONAL_DATA: 'true' })).toBe(true)
    for (const value of [undefined, '', 'TRUE', '1', 'yes', 'true ']) {
      expect(parseAllowPersonalData({ COLADA_ALLOW_PERSONAL_DATA: value })).toBe(false)
    }
  })
})

describe('check 1: service format (AC26)', () => {
  it.each(['S-events', 's-consr-events-registration', 's-events/../s-access', 'events', 's-', 's-events-', ''])(
    '"%s" is refused',
    (service) => {
      const message = `Service "${service}" is not allowed. Pass a backoffice service name like s-events (lower case). CONSR services (s-consr-*) cannot be called with this token.`
      expect(refusal('GET', service, '/api/x')).toBe(message)
      expect(() => checkService(service)).toThrow(message)
    }
  )

  it('a backoffice service passes', () => {
    expect(() => checkService('s-events-resources')).not.toThrow()
  })
})

describe('check 2: path format (AC26, G3)', () => {
  it.each([
    ['/events/e1', 'it must start with /api/'],
    ['api/events', 'it must start with /api/'],
    ['/api/events?q=1', 'it must not contain "?" or "#"'],
    ['/api/events#x', 'it must not contain "?" or "#"'],
    ['/api/events/e1%2Fguests', 'it must not contain an encoded "/", "." or "\\" (%2F, %2E, %5C)'],
    ['/api/events/e1%2fguests', 'it must not contain an encoded "/", "." or "\\" (%2F, %2E, %5C)'],
    ['/api/events/%2e%2e/guests', 'it must not contain an encoded "/", "." or "\\" (%2F, %2E, %5C)'],
    ['/api/events/%2E%2E/guests', 'it must not contain an encoded "/", "." or "\\" (%2F, %2E, %5C)'],
    ['/api/events%5cguests', 'it must not contain an encoded "/", "." or "\\" (%2F, %2E, %5C)'],
    ['/api/events%5Cguests', 'it must not contain an encoded "/", "." or "\\" (%2F, %2E, %5C)'],
    ['/api/events/%zz', 'it has an invalid %-encoding'],
    ['/api/events/../access', 'it must not contain ".." or "//"'],
    ['/api//events', 'it must not contain ".." or "//"'],
    ['/api/events/%2', 'it has an invalid %-encoding']
  ])('"%s" is refused: %s', (path, reason) => {
    expect(refusal('GET', 's-events', path, true)).toBe(pathRefused(path, reason))
  })

  it('the path check runs before the method check', () => {
    expect(refusal('GET', 's-events', '/events')).toBe(pathRefused('/events', 'it must start with /api/'))
  })
})

describe('checks 3 and 4: method and DELETE allowlist (AC21, AC23)', () => {
  it.each(['GET', 'HEAD', 'OPTIONS', 'TRACE', 'get'])('api_write refuses %s', (method) => {
    expect(() => checkWrite(method, { service: 's-events', path: '/api/events' }, true)).toThrow(
      `Method "${method}" is not supported by api_write. Use POST, PUT or PATCH; use api_get for GET.`
    )
  })

  it.each(['post', 'Put', 'PATCH'])('api_write accepts %s and upper-cases it', (method) => {
    expect(checkWrite(method, { service: 's-events', path: '/api/events' }, false).method).toBe(method.toUpperCase())
  })

  it.each(['DELETE', 'delete'])('every %s is blocked while the allowlist is empty', (method) => {
    expect(() => checkWrite(method, { service: 's-events', path: '/api/events/e1' }, true)).toThrow(
      'DELETE /_gw/s-events/api/events/e1 is blocked: only DELETE routes on the MCP allowlist are sent, and this route is not on it. Delete data in the backoffice.'
    )
  })

  it('api_get always checks GET', () => {
    expect(checkRead({ service: 's-events', path: '/api/events' }, false).method).toBe('GET')
  })
})

describe('check 8: header allowlist (AC27)', () => {
  it.each([
    'X-Colada-Workspace-Id',
    'x-colada-user',
    'Authorization',
    'Accept',
    'Accept-Language',
    'Content-Type',
    'Host',
    'Cookie'
  ])('header %s is refused', (name) => {
    expect(refusal('GET', 's-events', '/api/events', false, { [name]: 'x' })).toBe(
      `Header "${name}" is not allowed. Only Range and If-Match can be passed; the MCP sets Authorization, Accept, Accept-Language and the workspace itself.`
    )
  })

  it('a value with CR or LF is refused', () => {
    expect(refusal('GET', 's-events', '/api/events', false, { Range: 'events 0-10\r\nX-A: b' })).toContain(
      'Header "Range" is not allowed.'
    )
  })

  it('Range and If-Match pass in any case and are sent with their canonical names', () => {
    const checked = check('PUT', 's-events', '/api/events/e1', false, { RANGE: 'events 0-10', 'if-match': 'r1' })
    expect(checked.headers).toEqual({ Range: 'events 0-10', 'If-Match': 'r1' })
  })
})

describe('check order (CONTRACT §3)', () => {
  it('a DELETE on a secret route shows the DELETE text', () => {
    expect(refusal('DELETE', 's-workspaces', '/api/workspaces/w1/smtp')).toContain(
      'only DELETE routes on the MCP allowlist'
    )
  })

  it('a delete route on a personal-data service shows the denylist text, not the switch text', () => {
    expect(refusal('PATCH', 's-events-guests', '/api/events/e1/guests')).toBe(
      deleteRoute('PATCH', 's-events-guests', '/api/events/e1/guests')
    )
  })

  it('a secret route on a personal-data service shows the secret text', () => {
    expect(refusal('PUT', 's-access', '/api/users/u1/reset-otp')).toBe(
      secretRoute('PUT', 's-access', '/api/users/u1/reset-otp')
    )
  })

  it('a bad header on a blocked route shows the route text', () => {
    expect(refusal('GET', 's-events-guests', '/api/x', false, { Cookie: 'a' })).toBe(
      personalDataService('s-events-guests')
    )
  })
})

describe('review fixes: the checked path is the path that is sent', () => {
  const sentPath = (path: string) => new URL(`https://h.example.com/_gw/s-events${path}`).pathname
  const charsReason = `it must only contain letters, digits, "-._~!$&'()*+,;=:@/" and %-escapes`

  it.each([
    ['/api/.\t./.\t./s-events-guests/api/events/e1/guests', charsReason],
    ['/api/stripe\\settings', charsReason],
    ['/api/workspaces/w1\\info', charsReason],
    ['/api/licenses/items\t', charsReason],
    ['/api/licenses/items ', charsReason],
    ['/api/licenses/it\nems', charsReason],
    ['/api/events/é', charsReason],
    ['/api/stripe/./settings', 'it must not contain a "." segment'],
    ['/api/stripe/payment-links/.', 'it must not contain a "." segment'],
    ['/api/./emailtemplates', 'it must not contain a "." segment'],
    ['/api/licenses/items%20', 'it must not contain an encoded space or control character'],
    ['/api/licenses/items%09', 'it must not contain an encoded space or control character'],
    ['/api/licenses/items%7f', 'it must not contain an encoded space or control character']
  ])('"%s" is refused: %s', (path, reason) => {
    expect(refusal('GET', 's-events', path, true)).toBe(pathRefused(path, reason))
  })

  it('every path the policy accepts is sent unchanged', () => {
    const candidates = [
      '/api/events/e1',
      '/api/events:(title,start)',
      '/api/events/e1/guests/%64elete/jobs',
      "/api/a-b_c.d~e!f$g&h'i*j+k,l;m=n:o@p",
      '/api/events/.hidden',
      '/api/events/a.b'
    ]
    for (const path of candidates) {
      expect(refusal('GET', 's-events', path, true)).toBeNull()
      expect(sentPath(path)).toBe(`/_gw/s-events${path}`)
    }
  })
})

describe('review fixes: headers and method', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('header %s is refused', (name) => {
    expect(refusal('GET', 's-events', '/api/events', false, { [name]: 'x' })).toContain(
      `Header "${name}" is not allowed.`
    )
  })

  it.each(['poſt', 'PUṪ', 'PATCH '])('method %s with non-ASCII or extra characters is refused', (method) => {
    expect(() => checkWrite(method, { service: 's-events', path: '/api/events' }, true)).toThrow(
      `Method "${method}" is not supported by api_write.`
    )
  })
})
