import { describe, expect, it } from 'vitest'
import { checkRead, checkWrite } from '../src/policy/index.js'
import { DocFormatError, indexDoc, type MarkerIndex, markerFor } from '../src/policy/markers.js'

const GUESTS_DOC = `
openapi: 3.0.3
info:
  title: guests
servers:
  - url: /_gw/s-events-guests
paths:
  /api/events/{event_id}/guests:
    get:
      x-personal-data: true
  /api/events/{event_id}/guests/count:
    get:
      x-personal-data: false
  /api/events/{event_id}/guests/{guest_id}:
    get:
      x-personal-data: true
    patch:
      x-personal-data: true
  /api/events/guests/count:
    get:
      x-personal-data: false
  /api/events/guests/{guest_id}:
    get:
      x-personal-data: true
  /public-api/workspaces/{workspace_id}/guests:
    get:
      x-personal-data: false
`

const EVENTS_DOC = `
info:
  x-personal-data: false
paths:
  /api/events:({fields}):
    get: {}
  /api/events/apps/{applicationId}/favourites/my:({fields}):
    get: {}
  /api/events/count:
    get: {}
  /api/events/{id}:
    get:
      x-personal-data: true
    delete: {}
  /api/events/{soft}:
    put: {}
`

const FINANCIALS_DOC = `
info:
  x-personal-data: false
paths:
  /api/events/financialsettings:
    get: {}
  /api/events/{event_id}/financialsettings:
    put: {}
`

const FORMS_DOC = `
info:
  x-personal-data: false
paths:
  /api/events/{event_id}/formtemplates/registration/published+:
    put: {}
`

describe('matcher (CONTRACT-phase3 §2, AC41)', () => {
  const guests = indexDoc(GUESTS_DOC)
  const events = [...indexDoc(EVENTS_DOC), ...indexDoc(FINANCIALS_DOC)]
  const forms = indexDoc(FORMS_DOC)

  it.each<[string, MarkerIndex, string, string, boolean | undefined]>([
    ['M1 own case: Count is not the literal count', guests, 'GET', '/api/events/e1/guests/Count', true],
    ['M1 literal count', guests, 'GET', '/api/events/e1/guests/count', false],
    ['M2 projection on request and key', events, 'GET', '/api/events:(id,name)', false],
    ['M2 key projection, plain request', events, 'GET', '/api/events', false],
    ['M2 projection after a param', events, 'GET', '/api/events/apps/a1/favourites/my:(id)', false],
    ['M3 param is one segment', guests, 'GET', '/api/events/e1/guests/g1/documents', undefined],
    ['M4 + is literal', forms, 'PUT', '/api/events/e1/formtemplates/registration/published+', false],
    ['M4 + is not a quantifier', forms, 'PUT', '/api/events/e1/formtemplates/registration/publishedd', undefined],
    ['M5 literal beats param under an event', guests, 'GET', '/api/events/e1/guests/count', false],
    ['M5 literal beats param at the top', guests, 'GET', '/api/events/guests/count', false],
    ['M5 count beats {id} in s-events', events, 'GET', '/api/events/count', false],
    ['M6 method decides which key matches', guests, 'PATCH', '/api/events/e1/guests/count', true],
    ['M6 no operation for the method', guests, 'PUT', '/api/events/e1/guests/g1', undefined],
    ['M8 servers url is not part of the key', guests, 'GET', '/api/events/e1/guests', true],
    ['M9 financials doc literal beats events doc {id}', events, 'GET', '/api/events/financialsettings', false],
    ['M11 trailing slash matches no key', guests, 'GET', '/api/events/e1/guests/count/', undefined],
    ['M12 ambiguous keys give one answer', events, 'PUT', '/api/events/e1', false],
    ['no match at all', guests, 'GET', '/api/other', undefined]
  ])('%s', (_name, index, method, path, expected) => {
    expect(markerFor(index, method, path)).toBe(expected)
  })

  it('M7 keys outside /api/ are not indexed', () => {
    expect(guests).toHaveLength(6)
    expect(markerFor(guests, 'GET', '/public-api/workspaces/w1/guests')).toBeUndefined()
  })

  describe('M10 same operation in two docs', () => {
    const doc = (marker: string) => `paths:\n  /api/events/{id}:\n    get:${marker}\n`
    const merged = (...markers: string[]) => markers.flatMap((marker) => indexDoc(doc(marker)))
    const TRUE = '\n      x-personal-data: true'
    const FALSE = '\n      x-personal-data: false'

    it('any true is true', () => {
      expect(markerFor(merged(FALSE, TRUE), 'GET', '/api/events/e1')).toBe(true)
      expect(markerFor(merged(TRUE, FALSE), 'GET', '/api/events/e1')).toBe(true)
      expect(markerFor(merged(' {}', TRUE), 'GET', '/api/events/e1')).toBe(true)
    })

    it('else any missing marker is no marker', () => {
      expect(markerFor(merged(FALSE, ' {}'), 'GET', '/api/events/e1')).toBeUndefined()
    })

    it('false only when all are false', () => {
      expect(markerFor(merged(FALSE, FALSE), 'GET', '/api/events/e1')).toBe(false)
    })
  })
})

describe('effective marker (AC39, CONTRACT-phase3 §1)', () => {
  const doc = (info: string, path: string, operation: string) =>
    `info:\n  title: t${info}\npaths:\n  /api/x:${path}\n    get:\n      summary: s${operation}\n`
  const marker = (value: string) => `\n  x-personal-data: ${value}`
  const at = (indent: number, value: string) => `\n${' '.repeat(indent)}x-personal-data: ${value}`
  const effective = (info: string, path: string, operation: string) =>
    markerFor(indexDoc(doc(info, path, operation)), 'GET', '/api/x')

  it('operation over path over info', () => {
    expect(effective(marker('true'), at(4, 'true'), at(6, 'false'))).toBe(false)
    expect(effective(marker('false'), at(4, 'true'), '')).toBe(true)
    expect(effective(marker('true'), '', '')).toBe(true)
    expect(effective(marker('false'), '', at(6, 'true'))).toBe(true)
    expect(effective('', '', '')).toBeUndefined()
  })

  it.each(['yes', '"true"', "'false'", '1', '0', 'null', '[true]', '{a: true}', '~'])(
    'a bad value %s is no marker on its level',
    (value) => {
      expect(effective(marker('false'), '', at(6, value))).toBe(false)
      expect(effective(marker(value), '', '')).toBeUndefined()
    }
  )

  it('YAML 1.2 booleans in any case are markers', () => {
    expect(effective(marker('True'), '', '')).toBe(true)
    expect(effective(marker('FALSE'), '', '')).toBe(false)
  })

  it('the info marker covers only operations in the doc (D57)', () => {
    expect(markerFor(indexDoc(doc(marker('false'), '', '')), 'GET', '/api/y')).toBeUndefined()
  })
})

describe('doc shape', () => {
  it('a doc that is not a map fails', () => {
    expect(() => indexDoc('- a\n- b\n')).toThrow(DocFormatError)
    expect(() => indexDoc('just text')).toThrow(DocFormatError)
  })

  it('paths that is not a map fails', () => {
    expect(() => indexDoc('paths:\n  - /api/x\n')).toThrow(DocFormatError)
  })

  it('invalid YAML fails', () => {
    expect(() => indexDoc('paths:\n  /api/x:\n    get: {\n')).toThrow()
    expect(() => indexDoc('paths:\n  /api/x: {}\n  /api/x: {}\n')).toThrow()
  })

  it('a doc without paths has no operations', () => {
    expect(indexDoc('info:\n  x-personal-data: false\n')).toEqual([])
  })

  it('path items and operations that are not maps are skipped', () => {
    const index = indexDoc('info:\n  x-personal-data: false\npaths:\n  /api/a: 1\n  /api/b:\n    get: text\n')
    expect(index).toEqual([])
  })

  it('only get, put, post, patch and delete are operations', () => {
    const index = indexDoc('paths:\n  /api/a:\n    head: {}\n    options: {}\n    parameters: []\n    post: {}\n')
    expect(index.map((operation) => operation.method)).toEqual(['POST'])
  })
})

describe('policy with markers (AC37, AC38, AC40, AC43)', () => {
  const guests = indexDoc(
    'paths:\n  /api/events/{event_id}/guests:\n    get:\n      x-personal-data: false\n    patch:\n      x-personal-data: false\n'
  )
  const events = indexDoc(
    'info:\n  x-personal-data: false\npaths:\n  /api/events/{id}:\n    get:\n      x-personal-data: true\n    delete: {}\n  /api/events/{event_id}/financialsettings:\n    put: {}\n'
  )
  const refusal = (run: () => unknown) => {
    try {
      run()
    } catch (err) {
      return (err as Error).message
    }
    return null
  }
  const personalData = (method: string, target: string) =>
    `${method} ${target} may return personal data and is off. To turn it on, set COLADA_ALLOW_PERSONAL_DATA=true in the MCP config and restart the client.`

  it('AC37: false opens a route of a service in PERSONAL_DATA_SERVICES', () => {
    const input = { service: 's-events-guests', path: '/api/events/e1/guests' }
    expect(refusal(() => checkRead(input, false))).toBe(
      personalData('GET', '/_gw/s-events-guests/api/events/e1/guests')
    )
    expect(refusal(() => checkRead(input, false, guests))).toBeNull()
  })

  it('AC38: true refuses a route the tables allow, with the same text', () => {
    const input = { service: 's-events', path: '/api/events/e1' }
    expect(refusal(() => checkRead(input, false))).toBeNull()
    expect(refusal(() => checkRead(input, false, events))).toBe(personalData('GET', '/_gw/s-events/api/events/e1'))
  })

  it('AC38: true is ignored with the switch on', () => {
    expect(refusal(() => checkRead({ service: 's-events', path: '/api/events/e1' }, true, events))).toBeNull()
  })

  it('AC40: no matching operation falls back to the tables', () => {
    const input = { service: 's-events-guests', path: '/api/events/e1/guests/g1' }
    expect(refusal(() => checkRead(input, false, guests))).toBe(
      personalData('GET', '/_gw/s-events-guests/api/events/e1/guests/g1')
    )
    expect(refusal(() => checkRead({ service: 's-events', path: '/api/other' }, false, events))).toBeNull()
  })

  it('AC40: an empty index ("no doc") falls back to the tables', () => {
    const input = { service: 's-events-guests', path: '/api/events/e1/guests' }
    expect(refusal(() => checkRead(input, false, []))).toBe(
      personalData('GET', '/_gw/s-events-guests/api/events/e1/guests')
    )
  })

  it('AC43: a false marker does not open a secret route (S18)', () => {
    const input = { service: 's-events', path: '/api/events/e1/financialsettings', headers: {} }
    expect(refusal(() => checkWrite('PUT', input, false, events))).toContain('reads or changes secrets')
    expect(refusal(() => checkWrite('PUT', input, true, events))).toContain('reads or changes secrets')
  })

  it('AC43: the secret check runs before the marker check', () => {
    const marked = indexDoc(
      'paths:\n  /api/events/{event_id}/financialsettings:\n    put:\n      x-personal-data: true\n'
    )
    const input = { service: 's-events', path: '/api/events/e1/financialsettings' }
    expect(refusal(() => checkWrite('PUT', input, false, marked))).toContain('reads or changes secrets')
  })

  it('AC43: a false marker does not open a delete denylist route (D01)', () => {
    const input = { service: 's-events-guests', path: '/api/events/e1/guests' }
    expect(refusal(() => checkWrite('PATCH', input, false, guests))).toContain('this route deletes data')
  })

  it('AC43: a false marker does not open DELETE outside the allowlist', () => {
    const input = { service: 's-events', path: '/api/events/e1' }
    expect(refusal(() => checkWrite('DELETE', input, false, events))).toContain(
      'only DELETE routes on the MCP allowlist'
    )
  })
})
