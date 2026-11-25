import { isDeepStrictEqual } from 'node:util'
import { fail } from './errors.js'

const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])
const INDEX = /^(0|[1-9]\d*)$/

export interface Change {
  path: string
  old?: unknown
  new?: unknown
}

export function parsePath(path: string): string[] {
  const segments = path.split('.')
  if (segments.some((segment) => segment === '')) throw fail.badUpdatePath(path, 'it has an empty segment')
  const unsafe = segments.find((segment) => UNSAFE_SEGMENTS.has(segment))
  if (unsafe !== undefined) throw fail.badUpdatePath(path, `"${unsafe}" is not allowed`)
  return segments
}

export function checkEditPaths(set: Record<string, unknown>, remove: readonly string[]) {
  const paths = [...remove, ...Object.keys(set)]
  for (const path of paths) parsePath(path)
  checkOverlaps(paths)
}

export function applyEdits(
  record: unknown,
  set: Record<string, unknown>,
  remove: readonly string[]
): { record: unknown; changes: Change[] } {
  if (record === null || typeof record !== 'object') throw fail.updateNotRecord()
  const root = structuredClone(record) as object
  const removals = remove.map((path) => ({ path, segments: parsePath(path) }))
  const sets = Object.entries(set).map(([path, value]) => ({ path, segments: parsePath(path), value }))
  checkOverlaps([...removals, ...sets].map((edit) => edit.path))
  checkShiftedIndexes(root, removals, sets)

  const changes: Change[] = []
  for (const { path, segments } of [...removals].sort((a, b) => compareForRemoval(a.segments, b.segments))) {
    changes.push({ path, old: removeAt(root, segments, path) })
  }
  for (const { path, segments, value } of sets) {
    const old = setAt(root, segments, value, path)
    if (old.found && isDeepStrictEqual(old.value, value)) continue
    changes.push(old.found ? { path, old: old.value, new: value } : { path, new: value })
  }
  return { record: root, changes: orderAsGiven(changes, [...remove, ...Object.keys(set)]) }
}

function checkOverlaps(paths: string[]) {
  for (const [index, path] of paths.entries()) {
    for (const other of paths.slice(index + 1)) {
      if (path === other || other.startsWith(`${path}.`) || path.startsWith(`${other}.`)) {
        throw fail.badUpdatePath(other, `it overlaps "${path}"`)
      }
    }
  }
}

function checkShiftedIndexes(
  root: object,
  removals: Array<{ segments: string[] }>,
  sets: Array<{ path: string; segments: string[] }>
) {
  const lowestRemoved = new Map<string, number>()
  for (const { segments } of removals) {
    const parent = segments.slice(0, -1)
    const index = Number(segments.at(-1))
    if (!Array.isArray(valueAt(root, parent)) || !Number.isInteger(index)) continue
    const key = parent.join('.')
    lowestRemoved.set(key, Math.min(lowestRemoved.get(key) ?? index, index))
  }
  for (const { path, segments } of sets) {
    for (let length = 0; length < segments.length; length++) {
      const lowest = lowestRemoved.get(segments.slice(0, length).join('.'))
      const segment = segments[length] ?? ''
      if (lowest !== undefined && INDEX.test(segment) && Number(segment) >= lowest) {
        throw fail.badUpdatePath(path, 'remove takes items out of the same array, so this index would move')
      }
    }
  }
}

function compareForRemoval(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as string
    const y = b[i] as string
    if (x === y) continue
    if (INDEX.test(x) && INDEX.test(y)) return Number(y) - Number(x)
    return x < y ? -1 : 1
  }
  return b.length - a.length
}

function orderAsGiven(changes: Change[], paths: string[]): Change[] {
  return [...changes].sort((a, b) => paths.indexOf(a.path) - paths.indexOf(b.path))
}

function valueAt(root: unknown, segments: readonly string[]): unknown {
  let current = root
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined
    if (Array.isArray(current)) {
      if (!INDEX.test(segment)) return undefined
      current = current[Number(segment)]
    } else {
      if (!Object.hasOwn(current, segment)) return undefined
      current = (current as Record<string, unknown>)[segment]
    }
  }
  return current
}

function removeAt(root: object, segments: string[], path: string): unknown {
  const parent = valueAt(root, segments.slice(0, -1))
  const key = segments.at(-1) as string
  if (Array.isArray(parent)) {
    if (!INDEX.test(key) || Number(key) >= parent.length) throw fail.badUpdatePath(path, 'it does not exist')
    return parent.splice(Number(key), 1)[0]
  }
  if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, key)) {
    throw fail.badUpdatePath(path, 'it does not exist')
  }
  const record = parent as Record<string, unknown>
  const old = record[key]
  delete record[key]
  return old
}

function setAt(
  root: object,
  segments: string[],
  value: unknown,
  path: string
): { found: true; value: unknown } | { found: false } {
  let current: unknown = root
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1
    if (Array.isArray(current)) {
      if (!INDEX.test(segment)) throw fail.badUpdatePath(path, `"${segment}" is not an index of an array`)
      const position = Number(segment)
      if (position >= current.length) {
        throw fail.badUpdatePath(path, `index ${position} is outside the array (${current.length} items)`)
      }
      if (last) {
        const old = current[position]
        current[position] = value
        return { found: true, value: old }
      }
      current = current[position]
      continue
    }
    if (current === null || typeof current !== 'object') {
      throw fail.badUpdatePath(path, `"${segments.slice(0, index).join('.')}" is not an object or array`)
    }
    const record = current as Record<string, unknown>
    if (last) {
      const found = Object.hasOwn(record, segment)
      const old = record[segment]
      record[segment] = value
      return found ? { found: true, value: old } : { found: false }
    }
    if (!Object.hasOwn(record, segment) || record[segment] === undefined) {
      if (INDEX.test(segments[index + 1] ?? '')) {
        throw fail.badUpdatePath(
          path,
          `"${segments.slice(0, index + 1).join('.')}" does not exist, and set never adds array items`
        )
      }
      record[segment] = {}
    }
    current = record[segment]
  }
  return { found: false }
}
