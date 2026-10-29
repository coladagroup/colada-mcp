import { messages, ToolError } from '../../errors.js'
import type { NodeRule } from './tables.js'

export interface Redacted {
  value: unknown
  removed: Set<string>
}

interface Pattern {
  text: string
  segments: string[]
  always: boolean
}

function patternsOf(rule: NodeRule, allowPersonalData: boolean): Pattern[] {
  const toPattern = (always: boolean) => (text: string) => ({ text, segments: text.split('.'), always })
  return [...rule.neverReturned.map(toPattern(true)), ...(allowPersonalData ? [] : rule.personal.map(toPattern(false)))]
}

function matching(patterns: Pattern[], path: readonly string[]): Pattern | undefined {
  return patterns
    .filter(
      ({ segments }) =>
        path.length >= segments.length &&
        segments.every((segment, index) => segment === '*' || segment === path[path.length - segments.length + index])
    )
    .sort((a, b) => Number(b.always) - Number(a.always) || b.segments.length - a.segments.length)[0]
}

export function redact(
  value: unknown,
  basePath: readonly string[],
  rule: NodeRule,
  allowPersonalData: boolean
): Redacted {
  const patterns = patternsOf(rule, allowPersonalData)
  const removed = new Set<string>()
  const walk = (current: unknown, path: string[]): unknown => {
    if (current === null || typeof current !== 'object') return current
    if (Array.isArray(current)) return current.map((item, index) => walkChild(item, [...path, String(index)]))
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(current)) {
      const childPath = [...path, key]
      const hit = matching(patterns, childPath)
      if (hit) removed.add(hit.text)
      else result[key] = walk(child, childPath)
    }
    return result
  }
  const walkChild = (item: unknown, path: string[]): unknown => {
    const hit = matching(patterns, path)
    if (!hit) return walk(item, path)
    removed.add(hit.text)
    return null
  }
  for (let length = 1; length <= basePath.length; length++) {
    const hit = matching(patterns, basePath.slice(0, length))
    if (hit) {
      removed.add(hit.text)
      return { value: null, removed }
    }
  }
  return { value: walk(value, [...basePath]), removed }
}

export function assertUsable(field: string, option: string, rule: NodeRule, allowPersonalData: boolean) {
  const hit = matching(patternsOf(rule, allowPersonalData), ['*record*', ...field.split('.')])
  if (!hit) return
  throw new ToolError(
    hit.always ? messages.firebaseSecretField(field, option) : messages.firebaseHiddenField(field, option)
  )
}
