export type Store = 'rtdb' | 'firestore'
export type Group = 'business' | 'mixed' | 'personal'
export type ProjectKind = 'projects' | 'planner'

export type ProjectLink =
  | { by: 'self'; kind: ProjectKind }
  | { by: 'key'; kinds: readonly ProjectKind[] }
  | { by: 'field'; fields: readonly string[] }

export interface NodeRule {
  id: string
  store: Store
  node: string
  group: Group
  permissions: readonly string[]
  link?: ProjectLink
  entityKeyed?: true
  ownRows?: true
  personal: readonly string[]
  neverReturned: readonly string[]
}

export const APP_VIEW = 'campaigns_app:view'
export const REPORTS_VIEW = 'campaigns_app/reports:view'
export const TIMESHEET_ME_VIEW = 'campaigns_app/timesheet/me:view'

const BUDGET_ROW_PERSONAL = [
  'content.reports.*.*.description',
  'content.invoices.*.supplier',
  'content.invoices.*.notes',
  'content.invoices.*.title'
]
const PROJECT_PEOPLE = ['owner', 'accountManager', 'deputies', 'requesters']
const TASK_PERSONAL = ['summary', 'comments', 'assignees', 'files', 'reminderEmail']
const TASKS = ['campaigns_app/tasks:view', 'campaigns_app/projects/tasks:view']
const BOTH: readonly ProjectKind[] = ['projects', 'planner']

function rule(
  id: string,
  store: Store,
  node: string,
  group: Group,
  permissions: readonly string[],
  extra: Partial<Pick<NodeRule, 'link' | 'entityKeyed' | 'ownRows' | 'personal' | 'neverReturned'>> = {}
): NodeRule {
  return { id, store, node, group, permissions, personal: [], neverReturned: [], ...extra }
}

export const CAMPAIGNS_RULES: readonly NodeRule[] = [
  rule('R01', 'rtdb', 'budgets', 'business', ['campaigns_app/projects/budget:view'], {
    link: { by: 'key', kinds: ['projects'] },
    personal: BUDGET_ROW_PERSONAL
  }),
  rule('R02', 'rtdb', 'plannerBudgets', 'business', ['campaigns_app/offers:view'], {
    link: { by: 'key', kinds: ['planner'] },
    personal: BUDGET_ROW_PERSONAL
  }),
  rule('R03', 'rtdb', 'units', 'business', [APP_VIEW]),
  rule('R04', 'rtdb', 'tags', 'business', [APP_VIEW]),
  rule('R05', 'rtdb', 'costCenters', 'business', [APP_VIEW]),
  rule('R06', 'rtdb', 'checklists', 'business', ['campaigns_app/administration/checklists:view']),
  rule('R07', 'rtdb', 'knowledgeBase', 'business', ['campaigns_app/knowledgeBase:view']),
  rule('R08', 'rtdb', 'currencies', 'business', [APP_VIEW]),
  rule('R09', 'rtdb', 'pdfTemplates', 'business', [APP_VIEW]),
  rule('R10', 'rtdb', 'projectCounter', 'business', [APP_VIEW]),
  rule('R11', 'rtdb', 'projects', 'mixed', [APP_VIEW], {
    link: { by: 'self', kind: 'projects' },
    personal: ['contact', 'invoiceContact', ...PROJECT_PEOPLE, 'snapshots.*.pdf', ...BUDGET_ROW_PERSONAL]
  }),
  rule('R12', 'rtdb', 'planner', 'mixed', ['campaigns_app/offers:view'], {
    link: { by: 'self', kind: 'planner' },
    personal: ['person', 'notes', ...PROJECT_PEOPLE, ...BUDGET_ROW_PERSONAL]
  }),
  rule('R13', 'rtdb', 'deals', 'mixed', ['campaigns_app/leads:view'], { personal: ['contact', 'summary', 'name'] }),
  rule('R14', 'rtdb', 'timesheet', 'mixed', [REPORTS_VIEW, TIMESHEET_ME_VIEW], {
    link: { by: 'field', fields: ['project'] },
    ownRows: true,
    personal: ['description']
  }),
  rule('R15', 'rtdb', 'invoices', 'mixed', ['campaigns_app/invoices:view'], {
    link: { by: 'key', kinds: BOTH },
    personal: ['percentageAmountDetails', 'pdf', 'stripePaymentLinkUrl']
  }),
  rule('R16', 'rtdb', 'taskBoards', 'mixed', TASKS, {
    link: { by: 'key', kinds: BOTH },
    personal: TASK_PERSONAL
  }),
  rule('R17', 'rtdb', 'tasks', 'mixed', TASKS, { link: { by: 'field', fields: ['source'] }, personal: TASK_PERSONAL }),
  rule('R18', 'rtdb', 'emailTemplates', 'mixed', ['campaigns_app/administration/emailTemplates:view'], {
    personal: ['body', 'design']
  }),
  rule('R19', 'rtdb', 'companyDetails', 'mixed', ['campaigns_app/administration/companyDetails:view'], {
    neverReturned: ['dropboxSignApiKey', 'skribbleApiKey', 'skribbleApiUsername']
  }),
  rule(
    'R20',
    'rtdb',
    'activities',
    'personal',
    [
      'campaigns_app/projects/activities:view',
      'campaigns_app/leads/activities:view',
      'campaigns_app/offers/activities:view'
    ],
    { link: { by: 'field', fields: ['source'] } }
  ),
  rule('R21', 'rtdb', 'comments', 'personal', [APP_VIEW], { entityKeyed: true }),
  rule('R22', 'rtdb', 'chat', 'personal', ['campaigns_app/chat:view']),
  rule('R23', 'rtdb', 'richChat', 'personal', [APP_VIEW]),
  rule('R24', 'rtdb', 'history', 'personal', [APP_VIEW], { link: { by: 'field', fields: ['source'] } }),
  rule('R25', 'rtdb', 'externalAssignees', 'personal', [APP_VIEW]),
  rule('R26', 'rtdb', 'accounts', 'personal', [APP_VIEW]),
  rule('D01', 'firestore', 'serviceTickets', 'mixed', ['campaigns_app/serviceTickets:view'], {
    personal: ['contact', 'description', 'assignees', 'mentions', 'mentionsComment']
  }),
  rule('D02', 'firestore', 'boardColumns', 'business', ['campaigns_app/serviceTickets:view']),
  rule('D03', 'firestore', 'snapshots', 'business', ['campaigns_app/offers:view'], {
    link: { by: 'field', fields: ['project', 'planner'] },
    personal: ['pdf']
  }),
  rule('D04', 'firestore', 'requestForms', 'business', ['campaigns_app/administration/forms:view']),
  rule('D05', 'firestore', 'approvalRules', 'business', ['campaigns_app/administration/approvalRules:view']),
  rule('D06', 'firestore', 'accountInfos', 'personal', ['campaigns_app/administration/directory:view'])
]
