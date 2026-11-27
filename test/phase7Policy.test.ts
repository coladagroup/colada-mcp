import { afterEach, describe, expect, it } from 'vitest'
import { stripStorageTokens } from '../src/firebase/read.js'
import { checkWrite } from '../src/policy/index.js'
import { firebaseSetup } from './firebaseFake.js'
import { createHarness, FakeWorld, type Harness, STAGE_HOST, WS_A, workspace } from './harness.js'

const E = '11111111-2222-4333-8444-555555555555'
const P = '22222222-2222-4333-8444-555555555555'
const R = '33333333-2222-4333-8444-555555555555'
const REQUIREMENT = `/api/events/${E}/phases/${P}/requirements/${R}`
const RESOURCE = `/api/events/${E}/resources/${R}`
const NOT_ON_LIST = 'only DELETE routes on the MCP allowlist'

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

const del = (service: string, path: string, allowPersonalData = true) =>
  checkWrite('DELETE', { service, path }, allowPersonalData)

describe('DELETE allowlist (S10, AC-7.8)', () => {
  it('allows one staffing requirement (X02) and one event resource (X03) with UUID ids', () => {
    expect(del('s-staffing', REQUIREMENT).method).toBe('DELETE')
    expect(del('s-events-resources', RESOURCE, false).method).toBe('DELETE')
    expect(del('s-events-resources', `/api/events/${E.toUpperCase()}/resources/${R.toUpperCase()}`, false).method).toBe(
      'DELETE'
    )
  })

  it.each([
    ['s-events-resources', `/api/events/${E}/resources/all`],
    ['s-events-resources', `/api/events/${E}/resources/rn_stage`],
    ['s-events-resources', `/api/events/${E}/resources/allocatable`],
    ['s-events-resources', `/api/events/${E}/resources/bookable`],
    ['s-events-resources', `/api/events/${E}/resources/r1`],
    ['s-events-resources', `/api/events/e1/resources/${R}`],
    ['s-events-resources', `${RESOURCE}/`],
    ['s-events-resources', `${RESOURCE}/slots`],
    ['s-events-resources', `/api/events/${E}/resources`],
    ['s-staffing', `/api/events/${E}/phases/${P}/requirements/req1`],
    ['s-staffing', `/api/events/${E}/phases/${P}/requirements`],
    ['s-staffing', `/api/events/${E}/phases/${P}`],
    ['s-staffing', `${REQUIREMENT}/`],
    ['s-events', `/api/events/${E}`],
    ['s-events-guests', `/api/events/${E}/guests/${R}`]
  ])('refuses DELETE %s %s', (service, path) => {
    expect(() => del(service, path)).toThrow(NOT_ON_LIST)
  })

  it('a staffing requirement DELETE needs personal data on', () => {
    expect(() => del('s-staffing', REQUIREMENT, false)).toThrow('may return personal data and is off')
  })
})

describe('s-staffing is personal data (S13, AC-7.12)', () => {
  async function setup(allowPersonalData: boolean) {
    const world = new FakeWorld()
    world.addRealm(STAGE_HOST, { user: 'frank', members: [WS_A], workspaces: [workspace(WS_A, 'Alpha')] })
    const h = await createHarness(world, [STAGE_HOST], undefined, allowPersonalData)
    world.seedRefreshToken(STAGE_HOST, h.store)
    harnesses.push(h)
    return h
  }

  it('with personal data off, a staff resource read is refused and nothing is sent', async () => {
    const h = await setup(false)
    const result = await h.call('api_get', { workspace: WS_A, service: 's-staffing', path: '/api/staffResources' })
    expect(result.isError).toBe(true)
    expect(result.body.error).toContain('may return personal data and is off')
    expect(h.world.backendRequests().filter((r) => r.url.pathname.startsWith('/_gw/s-staffing/'))).toHaveLength(0)
  })

  it('with personal data on, the read is sent', async () => {
    const h = await setup(true)
    await h.call('api_get', { workspace: WS_A, service: 's-staffing', path: '/api/staffResources' })
    expect(h.world.backendRequests().filter((r) => r.url.pathname.startsWith('/_gw/s-staffing/'))).toHaveLength(1)
  })
})

describe('Firebase Storage links (S14, AC-7.11)', () => {
  const LINK = 'https://firebasestorage.googleapis.com/v0/b/app.appspot.com/o/slips%2F1.pdf'

  it('removes token at any depth and keeps the other parameters', () => {
    const input = {
      url: `${LINK}?alt=media&token=abc-123`,
      list: [{ deep: { file: `${LINK}?token=abc&alt=media` } }],
      text: `see ${LINK}?alt=media&token=xyz now`,
      other: 'https://example.com/file?token=keep',
      plain: `${LINK}?alt=media`,
      n: 3
    }
    expect(stripStorageTokens(input)).toEqual({
      url: `${LINK}?alt=media`,
      list: [{ deep: { file: `${LINK}?alt=media` } }],
      text: `see ${LINK}?alt=media now`,
      other: 'https://example.com/file?token=keep',
      plain: `${LINK}?alt=media`,
      n: 3
    })
  })

  it('removes token from links inside HTML, where & is written as &amp;', () => {
    const html = `<img src="${LINK}?alt=media&amp;token=abc-123"><a href='${LINK}?token=t2&amp;alt=media'>x</a>`
    expect(stripStorageTokens(html)).toBe(`<img src="${LINK}?alt=media"><a href='${LINK}?alt=media'>x</a>`)
  })

  it('removes token from a file name with parentheses and keeps a closing bracket of the text', () => {
    const file = 'https://firebasestorage.googleapis.com/v0/b/app.appspot.com/o/Offer%20(1).pdf'
    expect(stripStorageTokens(`(${file}?alt=media&token=secret)`)).toBe(`(${file}?alt=media)`)
    expect(stripStorageTokens(`${file}?token=secret`)).toBe(file)
  })

  it('rtdb_get returns no Storage link with a token', async () => {
    const { h, fw } = await firebaseSetup({})
    harnesses.push(h)
    fw.rtdb[WS_A] = { tags: { g1: { name: 'Billable', icon: `${LINK}?alt=media&token=secret-token` } } }
    const result = await h.call('rtdb_get', { workspace: WS_A, app: 'campaigns', path: 'tags' })
    expect(result.isError).toBe(false)
    expect(result.text).toContain(`${LINK}?alt=media`)
    expect(result.text).not.toContain('token=')
  })

  it('rtdb_get keeps the token when personal data is allowed', async () => {
    const { h, fw } = await firebaseSetup({ allowPersonalData: true })
    harnesses.push(h)
    fw.rtdb[WS_A] = { tags: { g1: { name: 'Billable', icon: `${LINK}?alt=media&token=secret-token` } } }
    const result = await h.call('rtdb_get', { workspace: WS_A, app: 'campaigns', path: 'tags' })
    expect(result.isError).toBe(false)
    expect(result.text).toContain(`${LINK}?alt=media&token=secret-token`)
  })
})
