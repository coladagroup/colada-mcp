import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, EVENT_A, FakeWorld, type Harness, json, WS_A, WS_B, workspace } from './harness.js'

const STAGE = 'stage-admin.colada365.com'
const EVENTS_PATH = '/_gw/s-events/api/events:(title,start,end,timeZone,status,isTemplate,archived)'
const TEMPLATES_PATH = `/_gw/s-email-templates/api/events/${EVENT_A}/emailtemplates/all`
const TEMPLATE_ID = '11111111-2222-3333-4444-555555555555'
const TEMPLATE_PATH = `/_gw/s-email-templates/api/events/${EVENT_A}/emailtemplates/${TEMPLATE_ID}`
const FORM_PATH = `/_gw/s-events-forms/api/events/${EVENT_A}/formtemplates/registration`
const DEFAULT_Q = 'status=!FINISHED&archived=!true&isTemplate=!true'

const harnesses: Harness[] = []

async function setup() {
  const world = new FakeWorld()
  world.addRealm(STAGE, {
    user: 'frank',
    members: [WS_A, WS_B],
    workspaces: [workspace(WS_A, 'Alpha'), workspace(WS_B, 'Beta')]
  })
  const harness = await createHarness(world)
  world.seedRefreshToken(STAGE, harness.store)
  harnesses.push(harness)
  return harness
}

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.close()
})

function paged(unit: string, all: unknown[]) {
  return (_url: URL, headers: Record<string, string>) => {
    const range = headers.range?.match(/^(\w+) (\d+)-(\d+)$/)
    const start = Number(range?.[2] ?? 0)
    const end = Number(range?.[3] ?? 40)
    return json(all.length > end - start ? 206 : 200, all.slice(start, end), {
      'Content-Range': `${unit} ${start}-${end}/${all.length}`
    })
  }
}

function events(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    uid: `ev-${i}`,
    revision: 1,
    createdBy: 'someone',
    properties: { title: `Event ${i}`, start: '2026-10-05T10:00', end: '2026-10-05T18:00', status: 'PUBLISHED' }
  }))
}

function templates(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `tpl-${i}`,
    createdAt: `2026-01-01T00:00:${i}`,
    updatedAt: '2026-02-01T00:00:00',
    createdBy: 'someone',
    updatedBy: 'someone',
    name: `name-${i}`,
    displayName: `Template ${i}`,
    l10n: {},
    from: 'noreply@colada.ag',
    to: '{{guest.email}}',
    cc: [],
    bcc: [],
    removable: true,
    attachments: [],
    automaticallyCreateCID: false,
    ...(i === 0 ? { sendingCondition: { relationship: 'OR', conditions: [] } } : {})
  }))
}

describe('list_events', () => {
  it('AC6: without q (or with an empty q) the default filter is sent, URI-encoded', async () => {
    const h = await setup()
    h.world.backendRaw.set(EVENTS_PATH, paged('events', events(3)))
    await h.call('list_events', { workspace: WS_A })
    await h.call('list_events', { workspace: WS_A, q: '' })

    for (const request of h.world.backendRequests().filter((r) => r.url.pathname === EVENTS_PATH)) {
      expect(request.url.search).toBe(`?q=${encodeURIComponent(DEFAULT_Q)}`)
      expect(request.url.searchParams.get('q')).toBe(DEFAULT_Q)
      expect(request.url.searchParams.has('sort')).toBe(false)
    }
  })

  it('AC7: a given q is sent exactly, encoded, with no default added', async () => {
    const h = await setup()
    h.world.backendRaw.set(EVENTS_PATH, paged('events', events(3)))
    const q = 'start=[2026-10-01T00:00,2026-11-01T00:00)&title=*Gala & Co*'
    await h.call('list_events', { workspace: WS_A, q })

    const request = h.world.backendRequests().at(-1)
    expect(request?.url.pathname).toBe(EVENTS_PATH)
    expect(request?.url.search).toBe(`?q=${encodeURIComponent(q)}`)
    expect(request?.url.searchParams.get('q')).toBe(q)
  })

  it('AC8: Range events S-(S+100), total from Content-Range, nextOffset only while more events exist', async () => {
    const h = await setup()
    h.world.backendRaw.set(EVENTS_PATH, paged('events', events(250)))

    const first = await h.call('list_events', { workspace: WS_A })
    expect(h.world.backendRequests().at(-1)?.headers.range).toBe('events 0-100')
    expect(first.body).toMatchObject({ total: 250, offset: 0, nextOffset: 100 })
    expect(first.body.items).toHaveLength(100)

    const last = await h.call('list_events', { workspace: WS_A, offset: 200 })
    expect(h.world.backendRequests().at(-1)?.headers.range).toBe('events 200-300')
    expect(last.body).toMatchObject({ total: 250, offset: 200 })
    expect(last.body).not.toHaveProperty('nextOffset')
    expect(last.body.items).toHaveLength(50)
  })

  it('AC8: exactly 100 events give no nextOffset', async () => {
    const h = await setup()
    h.world.backendRaw.set(EVENTS_PATH, paged('events', events(100)))
    const result = await h.call('list_events', { workspace: WS_A })
    expect(result.body).toMatchObject({ total: 100, offset: 0 })
    expect(result.body).not.toHaveProperty('nextOffset')
  })

  it('maps items to id and the projected fields; missing isTemplate/archived are false, others null', async () => {
    const h = await setup()
    h.world.backendRaw.set(
      EVENTS_PATH,
      paged('events', [
        ...events(1),
        { uid: 'ev-t', properties: { title: 'Tpl', timeZone: 'Europe/Zurich', isTemplate: true, archived: true } }
      ])
    )
    const result = await h.call('list_events', { workspace: WS_A })
    expect(result.body.items).toEqual([
      {
        id: 'ev-0',
        title: 'Event 0',
        start: '2026-10-05T10:00',
        end: '2026-10-05T18:00',
        timeZone: null,
        status: 'PUBLISHED',
        isTemplate: false,
        archived: false
      },
      {
        id: 'ev-t',
        title: 'Tpl',
        start: null,
        end: null,
        timeZone: 'Europe/Zurich',
        status: null,
        isTemplate: true,
        archived: true
      }
    ])
  })

  it('a list answer without a Content-Range total is an error', async () => {
    const h = await setup()
    h.world.backendRaw.set(EVENTS_PATH, () => json(200, events(1)))
    const result = await h.call('list_events', { workspace: WS_A })
    expect(result.body.error).toBe(`GET ${EVENTS_PATH} failed (200).`)
  })
})

describe('list_email_templates', () => {
  it('AC9: reads all pages with sort createdAt:asc and drops cc, bcc, removable, l10n, attachments, CID', async () => {
    const h = await setup()
    h.world.backendRaw.set(TEMPLATES_PATH, paged('emailtemplates', templates(250)))
    const result = await h.call('list_email_templates', { workspace: WS_A, eventId: EVENT_A })

    const requests = h.world.backendRequests().filter((r) => r.url.pathname === TEMPLATES_PATH)
    expect(requests.map((r) => r.headers.range)).toEqual([
      'emailtemplates 0-100',
      'emailtemplates 100-200',
      'emailtemplates 200-300'
    ])
    for (const request of requests) expect(request.url.search).toBe('?sort=createdAt%3Aasc')

    const items = result.body.items as Array<Record<string, unknown>>
    expect(result.body).toMatchObject({ eventId: EVENT_A, total: 250 })
    expect(items).toHaveLength(250)
    expect(new Set(items.map((i) => i.id)).size).toBe(250)
    expect(items[0]).toEqual({
      id: 'tpl-0',
      name: 'name-0',
      displayName: 'Template 0',
      from: 'noreply@colada.ag',
      to: '{{guest.email}}',
      sendingCondition: { relationship: 'OR', conditions: [] },
      createdAt: '2026-01-01T00:00:0',
      updatedAt: '2026-02-01T00:00:00'
    })
    expect(items[1]).not.toHaveProperty('sendingCondition')
    for (const field of ['cc', 'bcc', 'removable', 'l10n', 'attachments', 'automaticallyCreateCID']) {
      expect(items.some((i) => field in i)).toBe(false)
    }
  })

  it('D22: an unknown event gives total 0 and no items after one request', async () => {
    const h = await setup()
    h.world.backendRaw.set(TEMPLATES_PATH, paged('emailtemplates', []))
    const result = await h.call('list_email_templates', { workspace: WS_A, eventId: EVENT_A })
    expect(result.isError).toBe(false)
    expect(result.body).toMatchObject({ total: 0, items: [] })
    expect(h.world.backendRequests().filter((r) => r.url.pathname === TEMPLATES_PATH)).toHaveLength(1)
  })

  it('AC11: 403 names the refused path without the query', async () => {
    const h = await setup()
    h.world.backendStatus.set(TEMPLATES_PATH, 403)
    const result = await h.call('list_email_templates', { workspace: WS_A, eventId: EVENT_A })
    expect(result.body.error).toBe(
      `GET ${TEMPLATES_PATH} was refused (403): your role lacks access to this endpoint. Ask an admin for the permission.`
    )
  })
})

describe('get_email_template and get_registration_form', () => {
  const body = { id: TEMPLATE_ID, subject: { en: 'Hi' }, body: { en: '<p>x</p>' }, nested: [{ a: null }] }

  it('AC10: get_email_template returns the body unchanged', async () => {
    const h = await setup()
    h.world.backendRaw.set(TEMPLATE_PATH, () => json(200, body))
    const result = await h.call('get_email_template', { workspace: WS_A, eventId: EVENT_A, templateId: TEMPLATE_ID })
    expect(result.body.template).toEqual(body)
    expect(h.world.backendRequests().at(-1)?.url.pathname).toBe(TEMPLATE_PATH)
  })

  it('AC10: get_registration_form returns the body unchanged', async () => {
    const h = await setup()
    h.world.backendRaw.set(FORM_PATH, () => json(200, body))
    const result = await h.call('get_registration_form', { workspace: WS_A, eventId: EVENT_A })
    expect(result.body.form).toEqual(body)
    expect(h.world.backendRequests().at(-1)?.url.pathname).toBe(FORM_PATH)
  })

  it('AC12: 404 of get_email_template names both ids', async () => {
    const h = await setup()
    const result = await h.call('get_email_template', { workspace: WS_A, eventId: EVENT_A, templateId: TEMPLATE_ID })
    expect(result.body.error).toBe(
      `Email template ${TEMPLATE_ID} of event ${EVENT_A} not found in workspace ${WS_A}. The event may not exist either.`
    )
  })

  it('AC12: 404 of get_registration_form names the event', async () => {
    const h = await setup()
    const result = await h.call('get_registration_form', { workspace: WS_A, eventId: EVENT_A })
    expect(result.body.error).toBe(
      `Event ${EVENT_A} has no registration form in workspace ${WS_A}, or the event does not exist.`
    )
  })

  it('AC11: 403 of get_registration_form names the path', async () => {
    const h = await setup()
    h.world.backendStatus.set(FORM_PATH, 403)
    const result = await h.call('get_registration_form', { workspace: WS_A, eventId: EVENT_A })
    expect(result.body.error).toBe(
      `GET ${FORM_PATH} was refused (403): your role lacks access to this endpoint. Ask an admin for the permission.`
    )
  })
})

describe('id checks', () => {
  const objectId = '0123456789abcdef01234567'

  it.each([
    [
      'get_email_template',
      { eventId: objectId, templateId: TEMPLATE_ID },
      `eventId "${objectId}" is not a valid Colada id.`
    ],
    [
      'get_email_template',
      { eventId: EVENT_A, templateId: 'welcome' },
      'templateId "welcome" is not a valid Colada id.'
    ],
    ['list_email_templates', { eventId: '../x' }, 'eventId "../x" is not a valid Colada id.'],
    ['get_registration_form', { eventId: 'abc' }, 'eventId "abc" is not a valid Colada id.']
  ])('%s with a wrong id form sends no request', async (tool, args, error) => {
    const h = await setup()
    const result = await h.call(tool, { workspace: WS_A, ...args })
    expect(result.body.error).toBe(error)
    expect(h.world.requests).toHaveLength(0)
  })

  it('the 24-character event id form is accepted by list_email_templates and get_registration_form', async () => {
    const h = await setup()
    await h.call('list_email_templates', { workspace: WS_A, eventId: objectId })
    await h.call('get_registration_form', { workspace: WS_A, eventId: objectId })
    const paths = h.world.backendRequests().map((r) => r.url.pathname)
    expect(paths).toContain(`/_gw/s-email-templates/api/events/${objectId}/emailtemplates/all`)
    expect(paths).toContain(`/_gw/s-events-forms/api/events/${objectId}/formtemplates/registration`)
  })
})

describe('all tools', () => {
  it('tools/list has the six read tools and logout', async () => {
    const h = await setup()
    const names = (await h.client.listTools()).tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'get_email_template',
      'get_event',
      'get_registration_form',
      'list_email_templates',
      'list_events',
      'list_workspaces',
      'logout'
    ])
  })

  it('AC13: the new tools send only GET with Accept-Language en', async () => {
    const h = await setup()
    h.world.backendRaw.set(EVENTS_PATH, paged('events', events(1)))
    h.world.backendRaw.set(TEMPLATES_PATH, paged('emailtemplates', templates(1)))
    await h.call('list_events', { workspace: WS_A })
    await h.call('list_email_templates', { workspace: WS_A, eventId: EVENT_A })
    await h.call('get_email_template', { workspace: WS_A, eventId: EVENT_A, templateId: TEMPLATE_ID })
    await h.call('get_registration_form', { workspace: WS_A, eventId: EVENT_A })
    const requests = h.world.backendRequests()
    expect(requests.length).toBeGreaterThanOrEqual(4)
    for (const request of requests) {
      expect(request.method).toBe('GET')
      expect(request.headers['accept-language']).toBe('en')
    }
  })
})
