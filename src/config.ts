export const REALMS = ['default', 'vw', 'abiomed', 'lidl'] as const
export type Realm = (typeof REALMS)[number]
export type Env = 'stage' | 'prod'

const REALM_HOSTS: Record<Env, Partial<Record<Realm, string>>> = {
  stage: {
    default: 'stage-admin.colada365.com'
  },
  prod: {
    default: 'admin.colada365.com',
    vw: 'vw.colada365.com',
    abiomed: 'abiomed.colada365.com',
    lidl: 'lidl-football-hub.com'
  }
}

export function parseEnv(value: string | undefined): Env {
  if (value === undefined || value === '') return 'stage'
  if (value === 'stage' || value === 'prod') return value
  throw new Error(`COLADA_ENV must be stage or prod, got "${value}".`)
}

export function isRealm(value: string): value is Realm {
  return (REALMS as readonly string[]).includes(value)
}

export function hostOf(env: Env, realm: Realm): string | undefined {
  return REALM_HOSTS[env][realm]
}
