import { messages, ToolError } from '../errors.js'

export interface FirebaseConfig {
  apiKey: string
  databaseHost: string
  projectId: string
}

const DATABASE_URL = /^https:\/\/([a-z0-9-]+\.firebaseio\.com|[a-z0-9-]+\.[a-z0-9-]+\.firebasedatabase\.app)\/?$/
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/
const API_KEY = /^[A-Za-z0-9_-]{20,100}$/

export function parseFirebaseConfig(workspace: string, body: unknown): FirebaseConfig {
  const config = (body ?? {}) as Record<string, unknown>
  const field = (name: string, pattern: RegExp, shown: (value: string) => string) => {
    const value = config[name]
    if (typeof value !== 'string' || !pattern.test(value)) {
      throw new ToolError(
        messages.firebaseBadConfig(workspace, name, typeof value === 'string' ? shown(value) : String(value))
      )
    }
    return value
  }
  const databaseURL = field('databaseURL', DATABASE_URL, (value) => value)
  return {
    apiKey: field('apiKey', API_KEY, () => 'hidden'),
    databaseHost: new URL(databaseURL).host,
    projectId: field('projectId', PROJECT_ID, (value) => value)
  }
}
