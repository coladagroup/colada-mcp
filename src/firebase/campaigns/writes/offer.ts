import { messages, ToolError } from '../../../errors.js'
import { defined } from './common.js'

export const OFFER_STATUSES = [
  'qualified',
  'inProgress',
  'calculation',
  'offered',
  'negotiation',
  'wonPostponed',
  'lostPostponed'
] as const
export const CURRENCIES = ['CHF', 'EUR', 'USD', 'JPY'] as const
export const CHANCES = ['TBD', '25%', '50%', '75%', '100%'] as const
export const REQUIRED_OFFER_FIELDS = ['name', 'client', 'startDate', 'endDate'] as const

const DATE_PAIRS = [
  ['startDate', 'endDate'],
  ['x_setup_start', 'x_setup_end'],
  ['x_setdown_start', 'x_setdown_end']
] as const
const EVENT_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const BOARDS = [{ id: 'backlog' }, { id: 'progress' }, { id: 'finished', final: true }, { id: 'archived' }]

export type Fields = Record<string, unknown>

function isEventTime(value: string): boolean {
  const match = EVENT_TIME.exec(value)
  if (!match) return false
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.toISOString().startsWith(value.slice(0, 10)) && hour < 24 && minute < 60
}

function storedTime(value: unknown, fallback: string): string | null {
  if (typeof value !== 'string' || value === '') return null
  return DATE_ONLY.test(value) ? `${value}T${fallback}` : value
}

export function checkEventFormats(input: Fields): void {
  for (const field of DATE_PAIRS.flat()) {
    const value = input[field]
    if (value !== undefined && (typeof value !== 'string' || !isEventTime(value))) {
      throw new ToolError(messages.writeBadDate(`${field} must be yyyy-MM-ddTHH:mm`))
    }
  }
}

export function checkEventPairs(input: Fields, stored: Fields): void {
  for (const [startField, endField] of DATE_PAIRS) {
    if (input[startField] === undefined && input[endField] === undefined) continue
    const start = storedTime(input[startField] ?? stored[startField], '00:00')
    const end = storedTime(input[endField] ?? stored[endField], '23:59')
    if (start !== null && end !== null && start > end) {
      throw new ToolError(messages.writeBadDate(`${startField} is after ${endField}`))
    }
  }
}

export function requireFields(fields: Fields, names: readonly string[]): void {
  const missing = names.find((name) => fields[name] === undefined || fields[name] === '' || fields[name] === null)
  if (missing) throw new ToolError(messages.writeMissingField(missing))
}

export function offerNumber(counter: number, year: number): string {
  return `${year}-${counter > 99 ? counter : String(counter).padStart(3, '0')}`
}

export function nextCounter(current: unknown): number {
  return typeof current === 'number' && current > 0 ? current + 1 : 1
}

export function generatePrefix(name: unknown): string {
  return typeof name === 'string' ? (name.match(/\b([A-Za-z0-9])/g) ?? []).join('').toUpperCase() : ''
}

export function taskBoardScaffold(uid: string, prefix: string) {
  return { uid, prefix, boards: BOARDS, taskCounter: 0 }
}

export function defaultBudget(rowUid: string) {
  return [{ uid: rowUid, name: '', content: { price: 0, selectedQuantity: 1 } }]
}

export function fromLead(deal: Fields): Fields {
  return defined({ name: deal.name, person: deal.contact, client: deal.client, status: deal.status })
}

export function newOffer(
  fields: Fields,
  ids: { uid: string; externalId: unknown; number: string },
  owner: string,
  now: string
): Fields {
  const { prefix: _prefix, ...settings } = fields
  return {
    guests: 10,
    ...settings,
    person: settings.person || '',
    currency: settings.currency || 'CHF',
    eventsNum: settings.eventsNum || 1,
    costCenter: settings.costCenter || '',
    total: 0,
    archived: false,
    number: ids.number,
    uid: ids.uid,
    ...defined({ externalId: ids.externalId }),
    createdAt: now,
    updatedAt: now,
    owner
  }
}

export function newLead(fields: Fields, ids: { uid: string; externalId: string }, owner: string, now: string) {
  const { prefix: _prefix, ...data } = fields
  return {
    ...data,
    status: data.status || 'qualified',
    chance: data.chance || '25%',
    owner,
    updatedBy: owner,
    updatedAt: now,
    createdAt: now,
    archived: false,
    externalId: ids.externalId,
    uid: ids.uid
  }
}

export function offerChanges(fields: Fields, stored: Fields): Fields {
  const changes = { ...fields }
  if (changes.client !== undefined && changes.client !== stored.client && changes.person === undefined) {
    changes.person = ''
  }
  if (changes.location !== undefined && changes.location !== stored.location && changes.rooms === undefined) {
    changes.rooms = ''
  }
  return changes
}

export function hasTreeNode(tree: unknown, uid: string): boolean {
  const nodes = Array.isArray(tree) ? tree : tree !== null && typeof tree === 'object' ? Object.values(tree) : []
  return nodes.some((node) => {
    if (node === null || typeof node !== 'object') return false
    const record = node as Fields
    return record.uid === uid || hasTreeNode(record.children, uid)
  })
}
