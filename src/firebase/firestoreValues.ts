type FirestoreValue = Record<string, unknown>

export function fromFirestoreValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return null
  const v = value as FirestoreValue
  if ('nullValue' in v) return null
  if ('booleanValue' in v) return v.booleanValue
  if ('integerValue' in v) {
    const parsed = Number(v.integerValue)
    return Number.isSafeInteger(parsed) ? parsed : String(v.integerValue)
  }
  if ('doubleValue' in v) return Number(v.doubleValue)
  if ('timestampValue' in v) return v.timestampValue
  if ('stringValue' in v) return v.stringValue
  if ('bytesValue' in v) return v.bytesValue
  if ('referenceValue' in v) {
    const reference = String(v.referenceValue)
    const index = reference.indexOf('/documents/')
    return index >= 0 ? reference.slice(index + '/documents/'.length) : reference
  }
  if ('geoPointValue' in v) return v.geoPointValue
  if ('arrayValue' in v) {
    const values = (v.arrayValue as { values?: unknown[] } | null)?.values ?? []
    return values.map(fromFirestoreValue)
  }
  if ('mapValue' in v) return fromFirestoreFields((v.mapValue as { fields?: unknown } | null)?.fields)
  return null
}

export function fromFirestoreFields(fields: unknown): Record<string, unknown> {
  if (fields === null || typeof fields !== 'object') return {}
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, fromFirestoreValue(value)]))
}

export function firestoreFieldPath(field: string): string {
  return field
    .split('.')
    .map((segment) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment) ? segment : `\`${segment.replace(/[`\\]/g, '\\$&')}\``))
    .join('.')
}
