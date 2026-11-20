import { z } from 'zod'
import { fail } from './errors.js'

export const MAX_SELECT_PATHS = 50

const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

export const selectInput = z
  .array(
    z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^.]+(\.[^.]+)*$/)
  )
  .min(1)
  .max(MAX_SELECT_PATHS)
  .optional()
  .describe(
    'Keep only these paths of the answer, in dot form; "*" stands for every array item or map value, for example ["id", "status", "sentMailMessages.*.status"]. When the answer is a list, each path applies to every item. Paths that do not exist are left out.'
  )

export function selectPaths(value: unknown, paths: readonly string[]): unknown {
  for (const path of paths) {
    const unsafe = path.split('.').find((segment) => UNSAFE_SEGMENTS.has(segment))
    if (unsafe !== undefined) throw fail.badSelect(path, `"${unsafe}" is not allowed`)
  }
  let result: unknown
  for (const path of paths) {
    const segments = path.split('.')
    const relative = Array.isArray(value) && segments[0] !== '*' ? ['*', ...segments] : segments
    result = merge(result, pick(value, relative))
  }
  if (result !== undefined) return result
  return Array.isArray(value) ? [] : {}
}

function pick(value: unknown, segments: readonly string[]): unknown {
  const [head, ...rest] = segments
  if (head === undefined) return value
  if (value === null || typeof value !== 'object') return undefined
  if (head === '*') {
    if (Array.isArray(value)) {
      const items = value.map((item) => pick(item, rest))
      return items.some((item) => item !== undefined)
        ? items.map((item) => (item === undefined ? {} : item))
        : undefined
    }
    const entries = Object.entries(value)
      .map(([key, item]) => [key, pick(item, rest)] as const)
      .filter(([, item]) => item !== undefined)
    return entries.length > 0 ? Object.fromEntries(entries) : undefined
  }
  if (Array.isArray(value) || !Object.hasOwn(value, head)) return undefined
  const picked = pick((value as Record<string, unknown>)[head], rest)
  return picked === undefined ? undefined : { [head]: picked }
}

function merge(a: unknown, b: unknown): unknown {
  if (a === undefined) return b
  if (b === undefined) return a
  if (Array.isArray(a) && Array.isArray(b)) {
    return Array.from({ length: Math.max(a.length, b.length) }, (_, index) => merge(a[index], b[index]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const result: Record<string, unknown> = { ...a }
    for (const [key, item] of Object.entries(b)) result[key] = merge(result[key], item)
    return result
  }
  return b
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
