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
const OPERATION_KEYS = ['get', 'put', 'post', 'patch', 'delete']
const MARKER = 'x-personal-data'

export class DocFormatError extends Error {}

export function indexDoc(yamlText: string): MarkerIndex {
  const doc: unknown = parse(yamlText)
  if (!isMap(doc)) throw new DocFormatError('the doc is not a map')
  const paths = doc.paths
  if (paths === undefined || paths === null) return []
  if (!isMap(paths)) throw new DocFormatError('paths is not a map')
  const docMarker = markerOf(doc.info)
  const index: MarkedOperation[] = []
  for (const [key, item] of Object.entries(paths)) {
    if (!key.startsWith('/api/') || !isMap(item)) continue
    const segments = segmentsOf(key.replace(PROJECTION_SUFFIX, ''))
    const pathMarker = markerOf(item) ?? docMarker
    for (const method of OPERATION_KEYS) {
      const operation = item[method]
      if (!isMap(operation)) continue
      index.push({ method: method.toUpperCase(), segments, marker: markerOf(operation) ?? pathMarker })
    }
  }
  return index
}

export function markerFor(index: MarkerIndex, method: string, path: string): Marker {
  const parts = path.replace(PROJECTION_SUFFIX, '').split('/')
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
