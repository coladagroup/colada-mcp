import { describe, expect, it } from 'vitest'
import { type AccessContext, checkFirebasePath, splitPath } from '../src/firebase/policy/check.js'
import { assertUsable, redact } from '../src/firebase/policy/redact.js'
import { applyRowRules, campaignsRole, hiddenProjectIds, isHiddenProject } from '../src/firebase/policy/rows.js'
import { CAMPAIGNS_RULES, type NodeRule } from '../src/firebase/policy/tables.js'

const WS = 'ws-1'
const APP = 'campaigns_app:view'
const ALL_PERMISSIONS = new Set(CAMPAIGNS_RULES.flatMap((rule) => [APP, ...rule.permissions]))

type Row = [id: string, store: 'rtdb' | 'firestore', node: string, group: 'B' | 'M' | 'P', permissions: string[]]

const CONTRACT_ROWS: Row[] = [
  ['R01', 'rtdb', 'budgets', 'B', ['campaigns_app/projects/budget:view']],
  ['R02', 'rtdb', 'plannerBudgets', 'B', ['campaigns_app/offers:view']],
  ['R03', 'rtdb', 'units', 'B', [APP]],
  ['R04', 'rtdb', 'tags', 'B', [APP]],
  ['R05', 'rtdb', 'costCenters', 'B', [APP]],
  ['R06', 'rtdb', 'checklists', 'B', ['campaigns_app/administration/checklists:view']],
  ['R07', 'rtdb', 'knowledgeBase', 'B', ['campaigns_app/knowledgeBase:view']],
  ['R08', 'rtdb', 'currencies', 'B', [APP]],
  ['R09', 'rtdb', 'pdfTemplates', 'B', [APP]],
  ['R10', 'rtdb', 'projectCounter', 'B', [APP]],
  ['R11', 'rtdb', 'projects', 'M', [APP]],
  ['R12', 'rtdb', 'planner', 'M', ['campaigns_app/offers:view']],
  ['R13', 'rtdb', 'deals', 'M', ['campaigns_app/leads:view']],
  ['R14', 'rtdb', 'timesheet', 'M', ['campaigns_app/reports:view', 'campaigns_app/timesheet/me:view']],
  ['R15', 'rtdb', 'invoices', 'M', ['campaigns_app/invoices:view']],
  ['R16', 'rtdb', 'taskBoards', 'M', ['campaigns_app/tasks:view', 'campaigns_app/projects/tasks:view']],
  ['R17', 'rtdb', 'tasks', 'M', ['campaigns_app/tasks:view', 'campaigns_app/projects/tasks:view']],
  ['R18', 'rtdb', 'emailTemplates', 'M', ['campaigns_app/administration/emailTemplates:view']],
  ['R19', 'rtdb', 'companyDetails', 'M', ['campaigns_app/administration/companyDetails:view']],
  [
    'R20',
    'rtdb',
    'activities',
    'P',
    [
      'campaigns_app/projects/activities:view',
      'campaigns_app/leads/activities:view',
      'campaigns_app/offers/activities:view'
    ]
  ],
  ['R21', 'rtdb', 'comments', 'P', [APP]],
  ['R22', 'rtdb', 'chat', 'P', ['campaigns_app/chat:view']],
  ['R23', 'rtdb', 'richChat', 'P', [APP]],
  ['R24', 'rtdb', 'history', 'P', [APP]],
  ['R25', 'rtdb', 'externalAssignees', 'P', [APP]],
  ['R26', 'rtdb', 'accounts', 'P', [APP]],
  ['D01', 'firestore', 'serviceTickets', 'M', ['campaigns_app/serviceTickets:view']],
  ['D02', 'firestore', 'boardColumns', 'B', ['campaigns_app/serviceTickets:view']],
  ['D03', 'firestore', 'snapshots', 'B', ['campaigns_app/offers:view']],
  ['D04', 'firestore', 'requestForms', 'B', ['campaigns_app/administration/forms:view']],
  ['D05', 'firestore', 'approvalRules', 'B', ['campaigns_app/administration/approvalRules:view']],
  ['D06', 'firestore', 'accountInfos', 'P', ['campaigns_app/administration/directory:view']]
]

type FieldRow = [id: string, cls: 'P' | 'S', fields: string[]]

const CONTRACT_FIELDS: FieldRow[] = [
  [
    'R01',
    'P',
    [
      'content.reports.*.*.description',
      'content.invoices.*.supplier',
      'content.invoices.*.notes',
      'content.invoices.*.title'
    ]
  ],
  [
    'R02',
    'P',
    [
      'content.reports.*.*.description',
      'content.invoices.*.supplier',
      'content.invoices.*.notes',
      'content.invoices.*.title'
    ]
  ],
  [
    'R11',
    'P',
    [
      'contact',
      'invoiceContact',
      'owner',
      'accountManager',
      'deputies',
      'requesters',
      'snapshots.*.pdf',
      'content.reports.*.*.description',
      'content.invoices.*.supplier',
      'content.invoices.*.notes',
      'content.invoices.*.title'
    ]
  ],
  [
    'R12',
    'P',
    [
      'person',
      'notes',
      'owner',
      'accountManager',
      'deputies',
      'requesters',
      'content.reports.*.*.description',
      'content.invoices.*.supplier',
      'content.invoices.*.notes',
      'content.invoices.*.title'
    ]
  ],
  ['R13', 'P', ['contact', 'summary', 'name']],
  ['R14', 'P', ['description']],
  ['R15', 'P', ['percentageAmountDetails', 'pdf', 'stripePaymentLinkUrl']],
  ['R16', 'P', ['summary', 'comments', 'assignees', 'files', 'reminderEmail']],
  ['R17', 'P', ['summary', 'comments', 'assignees', 'files', 'reminderEmail']],
  ['R18', 'P', ['body', 'design']],
  ['R19', 'S', ['dropboxSignApiKey', 'skribbleApiKey', 'skribbleApiUsername']],
  ['D01', 'P', ['contact', 'description', 'assignees', 'mentions', 'mentionsComment']],
  ['D03', 'P', ['pdf']]
]

function ruleOf(id: string): NodeRule {
  const found = CAMPAIGNS_RULES.find((rule) => rule.id === id)
  if (!found) throw new Error(`no rule ${id}`)
  return found
}

function access(overrides: Partial<AccessContext> = {}): AccessContext {
  return { permissions: ALL_PERMISSIONS, allowPersonalData: true, workspace: WS, ...overrides }
}

function messageOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    return (err as Error).message
  }
  return ''
}

function setAt(path: string, value: unknown): Record<string, unknown> {
  const segments = path.split('.').map((segment) => (segment === '*' ? 'k' : segment))
  const root: Record<string, unknown> = {}
  let current = root
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) current[segment] = value
    else {
      const next: Record<string, unknown> = {}
      current[segment] = next
      current = next
    }
  })
  return root
}

describe('allowlist table = CONTRACT-phase4 §2', () => {
  it('has exactly the 26 RTDB and 6 Firestore rows of the contract, with group and permissions', () => {
    const groups = { business: 'B', mixed: 'M', personal: 'P' } as const
    expect(CAMPAIGNS_RULES.map((r) => [r.id, r.store, r.node, groups[r.group], [...r.permissions]])).toEqual(
      CONTRACT_ROWS
    )
  })

  it('has exactly the field rules of CONTRACT-phase4 §3', () => {
    const actual = CAMPAIGNS_RULES.flatMap((r): FieldRow[] => [
      ...(r.personal.length ? [[r.id, 'P', [...r.personal]] as FieldRow] : []),
      ...(r.neverReturned.length ? [[r.id, 'S', [...r.neverReturned]] as FieldRow] : [])
    ])
    expect(actual).toEqual(CONTRACT_FIELDS)
  })

  it.each(CONTRACT_ROWS)('%s %s %s is allowed with its permission', (_id, store, node, _group, permissions) => {
    for (const permission of permissions) {
      const checked = checkFirebasePath(store, node, access({ permissions: new Set([APP, permission]) }))
      expect(checked.rule.node).toBe(node)
      expect(checked.rest).toEqual([])
    }
  })

  it.each(CONTRACT_ROWS.filter((row) => !row[4].every((p) => p === APP)))(
    'AC-F10: %s %s %s is refused without its permission and names it',
    (_id, store, node, _group, permissions) => {
      const text = messageOf(() => checkFirebasePath(store, node, access({ permissions: new Set([APP]) })))
      expect(text).toContain(`so ${node} cannot be read`)
      for (const permission of permissions) expect(text).toContain(permission)
    }
  )

  it.each(CONTRACT_ROWS.filter((row) => !row[4].includes(APP)))(
    'AC-F10: %s %s %s needs campaigns_app:view too',
    (_id, store, node, _group, permissions) => {
      const text = messageOf(() => checkFirebasePath(store, node, access({ permissions: new Set(permissions) })))
      expect(text).toBe(`You lack campaigns_app:view in workspace ${WS}, so ${node} cannot be read.`)
    }
  )

  it.each(CONTRACT_ROWS.filter((row) => row[4].includes(APP)))(
    'AC-F10: %s %s %s is refused with no permission at all',
    (_id, store, node) => {
      expect(messageOf(() => checkFirebasePath(store, node, access({ permissions: new Set() })))).toBe(
        `You lack campaigns_app:view in workspace ${WS}, so ${node} cannot be read.`
      )
    }
  )

  it.each(CONTRACT_ROWS.filter((row) => row[3] === 'P'))(
    'AC-F14: personal node %s %s %s is refused while personal data is off',
    (_id, store, node) => {
      expect(messageOf(() => checkFirebasePath(store, node, access({ allowPersonalData: false })))).toBe(
        `${node} holds personal data. It is off; COLADA_ALLOW_PERSONAL_DATA=true turns it on.`
      )
    }
  )

  it.each(CONTRACT_ROWS.filter((row) => row[3] !== 'P'))(
    '%s %s %s is open while personal data is off',
    (_id, store, node) => {
      expect(checkFirebasePath(store, node, access({ allowPersonalData: false })).rule.node).toBe(node)
    }
  )
})

describe('AC-F9: never readable', () => {
  it.each([
    ['rtdb', 'secrets'],
    ['rtdb', 'secrets/dropboxSignApiKey'],
    ['rtdb', 'users'],
    ['rtdb', 'portal'],
    ['rtdb', 'externalIds'],
    ['rtdb', 'workspaceIds'],
    ['rtdb', 'reminders'],
    ['rtdb', 'mail'],
    ['rtdb', 'serviceTickets'],
    ['firestore', 'requests'],
    ['firestore', 'contactInfos'],
    ['firestore', 'notification'],
    ['firestore', 'serviceTicketHistory'],
    ['firestore', 'serviceTicketInvoices'],
    ['firestore', 'incomeInvoices'],
    ['firestore', 'accountContracts'],
    ['firestore', 'mail'],
    ['firestore', 'timesheet']
  ] as const)('%s %s is refused, also with personal data on', (store, path) => {
    expect(messageOf(() => checkFirebasePath(store, path, access()))).toMatch(
      /is not on the (rtdb|firestore) allowlist/
    )
  })

  it('the workspace node itself (empty path) is refused', () => {
    expect(messageOf(() => checkFirebasePath('rtdb', '', access()))).toContain('the workspace root cannot be read')
  })
})

describe('AC-F8: path rules (CONTRACT §5.1)', () => {
  it.each([
    ['/timesheet', 'empty segment'],
    ['timesheet/', 'empty segment'],
    ['timesheet//x', 'empty segment'],
    ['timesheet/..', '"." and ".." are not allowed'],
    ['timesheet/.', '"." and ".." are not allowed'],
    ['../secrets', '"." and ".." are not allowed'],
    ['timesheet%2f..', '? # [ ] $ %'],
    ['timesheet%2e', '? # [ ] $ %'],
    ['tags%5csecrets', '? # [ ] $ %'],
    ['tags\\x', '? # [ ] $ %'],
    ['tags?shallow=true', '? # [ ] $ %'],
    ['tags#x', '? # [ ] $ %'],
    ['tags/$key', '? # [ ] $ %'],
    ['tags/[0]', '? # [ ] $ %'],
    ['tags/a\u0000b', '? # [ ] $ %'],
    [`tags/${'x'.repeat(800)}`, 'longer than 768 bytes']
  ])('refuses %j', (path, reason) => {
    expect(messageOf(() => splitPath(path))).toContain(reason)
  })

  it('splits a normal path', () => {
    expect(splitPath('budgets/p1/0/content')).toEqual(['budgets', 'p1', '0', 'content'])
  })

  it.each([
    ['firestore', 'serviceTickets/t1/history', 'only a collection or one document'],
    ['rtdb', 'timesheet/r1/hours', 'read the whole record timesheet/<id>'],
    ['rtdb', 'tasks/t1/summary', 'read the whole record tasks/<id>'],
    ['rtdb', 'activities/a1/text', 'read the whole record activities/<id>'],
    ['firestore', 'snapshots/s1/x', 'only a collection or one document']
  ] as const)('%s %s is refused: %s', (store, path, reason) => {
    expect(messageOf(() => checkFirebasePath(store, path, access()))).toContain(reason)
  })

  it('a deeper read is fine where the project link is the key', () => {
    expect(checkFirebasePath('rtdb', 'budgets/p1/0/content', access()).rest).toEqual(['p1', '0', 'content'])
  })
})

describe('timesheet mode (F24)', () => {
  it.each([
    [['campaigns_app/reports:view'], 'all'],
    [['campaigns_app/reports:view', 'campaigns_app/timesheet/me:view'], 'all'],
    [['campaigns_app/timesheet/me:view'], 'own']
  ])('%j → %s', (permissions, mode) => {
    expect(
      checkFirebasePath('rtdb', 'timesheet', access({ permissions: new Set([APP, ...permissions]) })).timesheetMode
    ).toBe(mode)
  })

  it('campaigns_app/timesheet:view alone is not enough (not used by the UI)', () => {
    const permissions = new Set([APP, 'campaigns_app/timesheet:view'])
    expect(messageOf(() => checkFirebasePath('rtdb', 'timesheet', access({ permissions })))).toContain(
      'one of campaigns_app/reports:view, campaigns_app/timesheet/me:view'
    )
  })
})

describe('field denylist (CONTRACT §3)', () => {
  const cases = CONTRACT_FIELDS.flatMap(([id, cls, fields]) => fields.map((field) => [id, cls, field] as const))

  it.each(cases)('%s %s %s is removed in a record and listed by name', (id, cls, field) => {
    const record = { keep: 1, ...setAt(field, 'VALUE') }
    const { value, removed } = redact({ r1: record }, [], ruleOf(id), false)
    expect(JSON.stringify(value)).not.toContain('VALUE')
    expect(JSON.stringify(value)).toContain('"keep":1')
    expect([...removed]).toEqual([field])
    const on = redact({ r1: record }, [], ruleOf(id), true)
    if (cls === 'P') expect(JSON.stringify(on.value)).toContain('VALUE')
    else expect(JSON.stringify(on.value)).not.toContain('VALUE')
  })

  it('AC-F15: secrets in companyDetails are removed also with personal data on', () => {
    const { value, removed } = redact(
      { name: 'Co', dropboxSignApiKey: 'SECRET', skribbleApiKeyLast4: '1234', hasSkribbleApiKey: true },
      [],
      ruleOf('R19'),
      true
    )
    expect(value).toEqual({ name: 'Co', skribbleApiKeyLast4: '1234', hasSkribbleApiKey: true })
    expect([...removed]).toEqual(['dropboxSignApiKey'])
  })

  it('removes nested copies at any depth: budget rows in subRows', () => {
    const budget = [
      {
        uid: 'g',
        subRows: [
          {
            uid: 'r',
            content: {
              price: 10,
              reports: { '2026-09-01': [{ hours: 2, owner: 'u1', description: 'met John' }] },
              invoices: [{ amount: 5, supplier: 'Bob', notes: 'x', title: 'y', currency: 'CHF' }]
            }
          }
        ]
      }
    ]
    const { value, removed } = redact(budget, ['p1'], ruleOf('R01'), false)
    expect(value).toEqual([
      {
        uid: 'g',
        subRows: [
          {
            uid: 'r',
            content: {
              price: 10,
              reports: { '2026-09-01': [{ hours: 2, owner: 'u1' }] },
              invoices: [{ amount: 5, currency: 'CHF' }]
            }
          }
        ]
      }
    ])
    expect([...removed].sort()).toEqual([
      'content.invoices.*.notes',
      'content.invoices.*.supplier',
      'content.invoices.*.title',
      'content.reports.*.*.description'
    ])
  })

  it('removes task copies inside taskBoards', () => {
    const boards = {
      src1: { prefix: 'T', boards: { b1: { tasks: { t1: { summary: 'S', assignees: ['a@b.c'], owner: 'u' } } } } }
    }
    const { value } = redact(boards, [], ruleOf('R16'), false)
    expect(value).toEqual({ src1: { prefix: 'T', boards: { b1: { tasks: { t1: { owner: 'u' } } } } } })
  })

  it('removes legacy list rows of projects and planner', () => {
    const projects = { p1: { name: 'P', list: [{ content: { reports: { d: [{ description: 'x', hours: 1 }] } } }] } }
    expect(redact(projects, [], ruleOf('R11'), false).value).toEqual({
      p1: { name: 'P', list: [{ content: { reports: { d: [{ hours: 1 }] } } }] }
    })
    expect(redact(projects, [], ruleOf('R12'), false).value).toEqual({
      p1: { name: 'P', list: [{ content: { reports: { d: [{ hours: 1 }] } } }] }
    })
  })

  it('a read that starts below the record matches by the full path from the node', () => {
    const { value, removed } = redact(
      { d: [{ description: 'x', hours: 1 }] },
      ['p1', '0', 'content', 'reports'],
      ruleOf('R01'),
      false
    )
    expect(value).toEqual({ d: [{ hours: 1 }] })
    expect([...removed]).toEqual(['content.reports.*.*.description'])
  })

  it('a read of the removed field itself returns null', () => {
    const { value, removed } = redact('met John', ['r1', 'description'], ruleOf('R14'), false)
    expect(value).toBeNull()
    expect([...removed]).toEqual(['description'])
  })

  it('keeps staff ids and business addresses (F5, D50, D54)', () => {
    const tpl = { name: 'T', sender: 'events@x.ch', cc: 'a@x.ch', body: '<p>hi</p>' }
    expect(redact({ t1: tpl }, [], ruleOf('R18'), false).value).toEqual({
      t1: { name: 'T', sender: 'events@x.ch', cc: 'a@x.ch' }
    })
    const row = { owner: 'u1', hours: 1, description: 'x', project: 'p1', account: 'a1' }
    expect(redact({ r1: row }, [], ruleOf('R14'), false).value).toEqual({
      r1: { owner: 'u1', hours: 1, project: 'p1', account: 'a1' }
    })
  })

  it('AC-F17: a removed field cannot be used in where / fields / groupBy / sum', () => {
    expect(messageOf(() => assertUsable('description', 'where', ruleOf('R14'), false))).toBe(
      '"description" is personal data and is hidden, so it cannot be used in where. COLADA_ALLOW_PERSONAL_DATA=true shows it.'
    )
    expect(messageOf(() => assertUsable('dropboxSignApiKey', 'fields', ruleOf('R19'), true))).toBe(
      '"dropboxSignApiKey" is a secret and is never returned, so it cannot be used in fields.'
    )
    expect(messageOf(() => assertUsable('description', 'where', ruleOf('R14'), true))).toBe('')
    expect(messageOf(() => assertUsable('hours', 'sum', ruleOf('R14'), false))).toBe('')
    expect(messageOf(() => assertUsable('content.reports.d.0.description', 'fields', ruleOf('R01'), false))).toContain(
      'is personal data'
    )
  })
})

describe('row rules (CONTRACT §4)', () => {
  const ctx = (overrides: Partial<Parameters<typeof applyRowRules>[3]> = {}) => ({
    store: 'rtdb' as const,
    path: 'x',
    uid: 'me',
    timesheetMode: 'all' as const,
    hidden: new Set<string>(),
    ...overrides
  })

  it("AC-F11: own mode keeps only the user's timesheet rows", () => {
    const rows = { a: { owner: 'me', hours: 1 }, b: { owner: 'other', hours: 2 }, c: { hours: 3 } }
    const result = applyRowRules(ruleOf('R14'), [], rows, ctx({ timesheetMode: 'own' }))
    expect(result).toEqual({ value: { a: { owner: 'me', hours: 1 } }, removedRecords: 2 })
    expect(applyRowRules(ruleOf('R14'), [], rows, ctx()).removedRecords).toBe(0)
  })

  it('AC-F11: own mode refuses one row of another owner as "not found"', () => {
    expect(
      messageOf(() =>
        applyRowRules(ruleOf('R14'), ['b'], { owner: 'other' }, ctx({ timesheetMode: 'own', path: 'timesheet/b' }))
      )
    ).toBe('Nothing found at rtdb timesheet/b.')
  })

  it('AC-F12: hidden projects are removed from projects and refused by id', () => {
    const hidden = new Set(['p2'])
    expect(applyRowRules(ruleOf('R11'), [], { p1: {}, p2: {} }, ctx({ hidden }))).toEqual({
      value: { p1: {} },
      removedRecords: 1
    })
    expect(
      messageOf(() => applyRowRules(ruleOf('R11'), ['p2', 'name'], 'Secret', ctx({ hidden, path: 'projects/p2/name' })))
    ).toBe('Nothing found at rtdb projects/p2/name.')
  })

  it.each(['R01', 'R02', 'R15', 'R16', 'R21'])('AC-F12: %s by path key', (id) => {
    const hidden = new Set(['p2'])
    expect(applyRowRules(ruleOf(id), [], { p1: 1, p2: 2 }, ctx({ hidden }))).toEqual({
      value: { p1: 1 },
      removedRecords: 1
    })
    expect(messageOf(() => applyRowRules(ruleOf(id), ['p2'], 2, ctx({ hidden })))).toContain('Nothing found')
  })

  it.each([
    ['R14', 'project'],
    ['R17', 'source'],
    ['R20', 'source'],
    ['R24', 'source'],
    ['D03', 'project'],
    ['D03', 'planner']
  ])('AC-F12: %s by field %s', (id, field) => {
    const hidden = new Set(['p2'])
    const records = { a: { [field]: 'p1' }, b: { [field]: 'p2' }, c: { [field]: 'ticket-1' } }
    expect(applyRowRules(ruleOf(id), [], records, ctx({ hidden }))).toEqual({
      value: { a: { [field]: 'p1' }, c: { [field]: 'ticket-1' } },
      removedRecords: 1
    })
    expect(messageOf(() => applyRowRules(ruleOf(id), ['b'], { [field]: 'p2' }, ctx({ hidden })))).toContain(
      'Nothing found'
    )
  })

  it.each(['R04', 'R13', 'R18', 'D01'])('%s has no row rule', (id) => {
    const hidden = new Set(['p2'])
    expect(applyRowRules(ruleOf(id), [], { p2: { project: 'p2', source: 'p2' } }, ctx({ hidden })).removedRecords).toBe(
      0
    )
  })
})

describe('hidden projects (F25, userUtils.js / useProjects.js)', () => {
  it('ports the getUserRole priority: super admin beats a lobby role', () => {
    expect(campaignsRole(['campaigns_app_requester', 'campaigns_app_super_admin'])).toBe('campaigns_app_super_admin')
    expect(campaignsRole(['campaigns_app_speaker', 'campaigns_app_service_employee'])).toBe(
      'campaigns_app_service_employee'
    )
    expect(campaignsRole(['campaigns_app_speaker'])).toBe('campaigns_app_speaker')
    expect(campaignsRole(['default-roles'])).toBe('')
  })

  it.each([
    [{ isPrivate: true }, 'campaigns_app_planner', true],
    [{ isPrivate: 'true' }, 'campaigns_app_planner', true],
    [{ isPrivate: 'false' }, 'campaigns_app_planner', true],
    [{ isPrivate: false }, 'campaigns_app_planner', false],
    [{}, 'campaigns_app_planner', false],
    [{ isPrivate: true, owner: 'me' }, 'campaigns_app_planner', false],
    [{ isPrivate: true, accountManager: 'me' }, 'campaigns_app_planner', false],
    [{ isPrivate: true, deputies: ['me'] }, 'campaigns_app_planner', false],
    [{ isPrivate: true, deputies: { 0: 'me' } }, 'campaigns_app_planner', false],
    [{ isPrivate: true, deputies: 'xmex' }, 'campaigns_app_planner', true],
    [{ isPrivate: true, requesters: ['me'] }, 'campaigns_app_planner', true],
    [{ isPrivate: true }, 'campaigns_app_super_admin', true],
    [{}, 'campaigns_app_requester', true],
    [{ requesters: ['me'] }, 'campaigns_app_requester', false],
    [{ deputies: ['me'] }, 'campaigns_app_speaker', false],
    [{ accountManager: 'me' }, 'campaigns_app_speaker', false],
    [{ owner: 'me' }, 'campaigns_app_requester', true],
    [{ requesters: ['me'], isPrivate: true }, 'campaigns_app_requester', true]
  ])('%j for %s → hidden %s', (project, role, hidden) => {
    expect(isHiddenProject(project, 'me', role)).toBe(hidden)
  })

  it('collects hidden ids over projects and planner', () => {
    const ids = hiddenProjectIds(
      [{ p1: { isPrivate: true }, p2: {} }, { o1: { isPrivate: 'true', owner: 'me' }, o2: { isPrivate: true } }, null],
      'me',
      'campaigns_app_planner'
    )
    expect([...ids].sort()).toEqual(['o2', 'p1'])
  })
})
