import { parse } from 'yaml'

export type Marker = boolean | undefined

export interface MarkedOperation {
  method: string
  segments: readonly Segment[]
  marker: Marker
}

export type MarkerIndex = readonly MarkedOperation[]

interface Segment {
  literal: boolean
  pattern: RegExp
}

const PROJECTION_SUFFIX = /:\([^/]*\)\/?$/
const TRAILING_SLASH = /(?<=.)\/$/
const OPERATION_KEYS = ['get', 'put', 'post', 'patch', 'delete']
const MARKER = 'x-personal-data'

export class DocFormatError extends Error {}

export function indexDoc(yamlText: string): MarkerIndex {
  const doc: unknown = parse(yamlText, { version: '1.2', schema: 'core', merge: true })
  if (!isMap(doc)) throw new DocFormatError('the doc is not a map')
  const paths = doc.paths
  if (paths === undefined || paths === null) return []
  if (!isMap(paths)) throw new DocFormatError('paths is not a map')
  const docMarker = markerOf(doc.info)
  const index: MarkedOperation[] = []
  for (const [key, item] of Object.entries(paths)) {
    if (!key.startsWith('/api/') || !isMap(item)) continue
    const path = key.replace(PROJECTION_SUFFIX, '')
    const segments = segmentsOf(path.replace(TRAILING_SLASH, ''))
    const target = item.$ref === undefined ? item : localRef(doc, item.$ref)
    const operations = target ?? item
    const pathMarker = markerOf(item) ?? markerOf(target) ?? docMarker
    for (const method of OPERATION_KEYS) {
      const operation = operations[method]
      if (!isMap(operation) && target !== undefined) continue
      const marker = markerOf(operation) ?? pathMarker
      const partial = target === undefined || TRAILING_SLASH.test(path)
      index.push({ method: method.toUpperCase(), segments, marker: partial ? onlyTrue(marker) : marker })
    }
  }
  return index
}

export function markerFor(index: MarkerIndex, method: string, path: string): Marker {
  const stripped = path.replace(PROJECTION_SUFFIX, '')
  const marker = bestMarker(index, method, stripped.replace(TRAILING_SLASH, '').split('/'))
  return TRAILING_SLASH.test(stripped) ? onlyTrue(marker) : marker
}

function bestMarker(index: MarkerIndex, method: string, parts: readonly string[]): Marker {
  let best: MarkedOperation[] = []
  for (const operation of index) {
    if (operation.method !== method || !matches(operation.segments, parts)) continue
    const order = best[0] === undefined ? 1 : compareSpecificity(operation.segments, best[0].segments)
    if (order > 0) best = [operation]
    else if (order === 0) best.push(operation)
  }
  if (best.length === 0) return undefined
  if (best.some((operation) => operation.marker === true)) return true
  if (best.some((operation) => operation.marker === undefined)) return undefined
  return false
}

function localRef(doc: Record<string, unknown>, ref: unknown): Record<string, unknown> | undefined {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined
  let node: unknown = doc
  for (const part of ref.slice(2).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~')
    if (!isMap(node) || !Object.hasOwn(node, key)) return undefined
    node = node[key]
  }
  return isMap(node) && node.$ref === undefined ? node : undefined
}

function onlyTrue(marker: Marker): Marker {
  return marker === true ? true : undefined
}

function matches(segments: readonly Segment[], parts: readonly string[]): boolean {
  return segments.length === parts.length && segments.every((segment, i) => segment.pattern.test(parts[i] ?? ''))
}

function compareSpecificity(a: readonly Segment[], b: readonly Segment[]): number {
  for (let i = 0; i < a.length; i++) {
    const left = a[i]?.literal ?? false
    const right = b[i]?.literal ?? false
    if (left !== right) return left ? 1 : -1
  }
  return 0
}

function segmentsOf(key: string): Segment[] {
  return key.split('/').map((segment) => {
    const source = segment
      .split(/(\{[^}/]*\})/)
      .map((part) => (/^\{[^}/]*\}$/.test(part) ? '[^/]+' : escapeRegExp(part)))
      .join('')
    return { literal: !segment.includes('{'), pattern: new RegExp(`^${source}$`) }
  })
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function markerOf(node: unknown): Marker {
  if (!isMap(node)) return undefined
  const value = node[MARKER]
  return typeof value === 'boolean' ? value : undefined
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
